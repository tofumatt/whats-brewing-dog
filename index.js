var cheerio = require('cheerio');
var express = require('express');
var htmlEntities = require('html-entities');
var redis = require('redis');
var redisClient = redis.createClient(process.env.REDIS_URL);
var request = require('request');

var BREW_TYPE_MAPPING = {
  'brewdog draft': 'brewDogBeers',
  'cider': 'ciders',
  'crafty devil takeover': 'craftyDevilTakeover',
  'guest draft': 'guestBeers',
};

var TIME_TO_EXPIRE = 21600; // six hours

var app = express();
app.use(express.static(__dirname + '/public'));

/*
 * Parse the name of the brewery from a guest ale (otherwise it's BrewDog).
 */
function getBreweryAndStrength(brew) {
  var brewMatches;
  var brewWithData = {};
  var entities = new htmlEntities.AllHtmlEntities();
  brew = entities.decode(brew).trim();

  // Look for a less likely format first; this usually crops up on the Two Bit
  // bar where they serve only guest brews and format things weirdly.
  brewMatches = brew.match(/(.*) - (\d+\.?\d*%) - (.*)/);
  if (brewMatches) {
    brewWithData.brewery = brewMatches[3].trim();
    brewWithData.name = brewMatches[1].trim();
    brewWithData.strength = brewMatches[2];
  } else {
    brewMatches = brew.match(/(.*) - (.*) (\d+\.?\d*%)/);

    if (brewMatches) {
      brewWithData.brewery = brewMatches[1].trim();
      brewWithData.name = brewMatches[2].trim();
      brewWithData.strength = brewMatches[3];
    }
  }

  if (!brewMatches) {
    brewMatches = brew.match(/(.*) (\d+\.?\d*%)/);
    brewWithData.brewery = 'BrewDog';
    brewWithData.name = brewMatches[1].trim();
    brewWithData.strength = brewMatches[2];
  }

  return brewWithData;
}

/*
 * Get the ranges of the brew list, used to assign each brew to a section.
 */
function getRanges(brewList) {
  var ranges = {};

  brewList.forEach(function(item, index) {
    if (!item.match('%')) {
      var brewType = item.replace(/-/g, '').trim().toLowerCase();
      ranges[BREW_TYPE_MAPPING[brewType]] = index + 1;

      if (index !== 0) {
        var lastType = Object.keys(ranges)[Object.keys(ranges).length - 2];

        ranges[lastType] = [ranges[lastType], index - 1];
      }
    }
  });

  var finalKey = Object.keys(ranges)[Object.keys(ranges).length - 1];
  if (finalKey) {
    ranges[finalKey] = [ranges[finalKey], Object.keys(brewList).length - 1];
  } else {
    delete ranges[finalKey];
  }

  if (!Object.keys(ranges).length) {
    ranges = null;
  }

  return ranges;
}

/*
 * Return an object of all brews, according to type.
 */
function loadBrewsByType(brewList) {
  // These are all know types of brews on tap at various bars; some may be
  // empty.
  var brews = {
    brewDogBeers: [],
    guestBeers: [],
    ciders: [],
    craftyDevilTakeover: [],
  };

  var ranges = getRanges(brewList);

  if (ranges) {
    // Brutely check through each brew type.
    Object.keys(brews).forEach(function(brewType) {
      brewList.forEach(function(item, index) {
        if (ranges[brewType] &&
            index >= ranges[brewType][0] && index <= ranges[brewType][1]) {
          brews[brewType].push(getBreweryAndStrength(item));
        }
      });
    });
  } else {
    // If no ranges are available; we need to parse things based on the brewery
    // data.
    brewList.forEach(function(item) {
      var brewData = getBreweryAndStrength(item);
      if (brewData.brewery === 'BrewDog') {
        brews.brewDogBeers.push(brewData);
      } else {
        // This is a quick hack to deal with ciders, which would otherwise get
        // lumped into guest ales at https://www.brewdog.com/bars/uk/two-bit.
        if (brewData.name.match(/cider/i)) {
          brews.ciders.push(brewData);
        } else {
          brews.guestBeers.push(brewData);
        }
      }
    });
  }

  return brews;
}

/*
 * Get all BrewDog locations based on raw HTML from site sidebar.
 *
 * Right now simply offered as an API, but in the future we can use this to
 * validate pub locations.
 *
 * HACK: Right now we hardcode group 0 as being UK and group 1 as being
 * international.
 */
function getLocationData(rawLocationsHTML) {
  var $ = cheerio.load(rawLocationsHTML);

  var groups = $('.sidebar > .sideNav .sideNav');

  var ukBars = groups.eq(0).find('li a');
  var intlBars = groups.eq(1).find('li a');

  var locations = {
    uk: [],
    international: [],
  };
  ukBars.each(function() {
    locations.uk.push({
      name: $(this).text().trim(),
      slug: $(this).attr('href').split('/bars/uk/')[1],
      url: 'https://www.brewdog.com' + $(this).attr('href'),
    });
  });
  intlBars.each(function() {
    locations.international.push({
      name: $(this).text().trim(),
      slug: $(this).attr('href').split('/bars/worldwide/')[1],
      url: 'https://www.brewdog.com' + $(this).attr('href'),
    });
  });

  return locations;
}

/*
 * Normalise HTML string into a usable object of tap data.
 *
 * We get a big dump of HTML from the web page; this processes out whitespace
 * and HTML tags into a usable object we can output as JSON.
 */
function normalizeOnTapData(string) {
  var brewList = string.split('<br>')
    .filter(function(item) {
      // Remove whitespace items, which crop up because of the HTML contents.
      return item.trim().length;
    });

  var brews = loadBrewsByType(brewList);

  return brews;
}

app.get('/locations.json', function(req, res) {
  var redisKey = 'locations';
  // First we'll check for cached data; we cache locations for a long time
  // (24 hours).
  redisClient.get(redisKey, function(err, reply) {
    if (err) {
      res.end('Redis failure');
    }

    var now = new Date().getTime();

    if (reply) {
      reply = JSON.parse(reply);
    }

    reply = false;

    // No cached data exists or it's outdated; fetch new data!
    if (!reply || reply.expiryTime < now) {
      var url = 'https://www.brewdog.com/bars';

      request(url, function(err, response, html) {
        if (err) {
          res.send({ error: err });
          return res.end();
        }

        var locationsData = getLocationData(html);

        // 24 hours.
        var expiryTime = new Date().getTime() + (TIME_TO_EXPIRE * 4 * 2);
        // var jsonToSave = JSON.stringify({
        //   expiryTime: expiryTime,
        //   locations: locationsData,
        // });
        // redisClient.set(redisKey, jsonToSave);

        res.send(locationsData);
        res.end();
      });
    } else {
      // We have cached data; send it across the wire!
      res.end(JSON.stringify(reply.locationsData));
    }
  });

});

app.get('/:country/:pub.json', function(req, res) {
  var country = req.params.country;
  var pub = req.params.pub;
  var redisKey = country + '/' + pub;

  // First we'll check for cached data; we cache things for 6 hours.
  redisClient.get(redisKey, function(err, reply) {
    if (err) {
      res.end('Redis failure');
    }

    var now = new Date().getTime();

    if (reply) {
      reply = JSON.parse(reply);
    }

    // No cached data exists or it's outdated; fetch new data!
    if (!reply || reply.expiryTime < now) {
      var url = 'https://www.brewdog.com/bars/' + country + '/' + pub;

      request(url, function(err, response, html) {
        if (err) {
          res.send({ error: err });
          return res.end();
        }

        if (response.statusCode !== 200) {
          res.send({ error: 'Pub not found' });
          return res.end();
        }

        var $ = cheerio.load(html);

        var onTapHTML = $('.onTapInfo .barText');

        var beerData = normalizeOnTapData(onTapHTML.html());

        var expiryTime = new Date().getTime() + TIME_TO_EXPIRE;
        var jsonToSave = JSON.stringify({
          beerData: beerData,
          expiryTime: expiryTime,
        });
        redisClient.set(redisKey, jsonToSave);

        res.send(beerData);
        res.end();
      });
    } else {
      // We have cached data; send it across the wire!
      res.end(JSON.stringify(reply.beerData));
    }
  });
});

var PORT = process.env.PORT ? process.env.PORT : '8080';

app.listen(PORT);
console.log('App running on port ' + PORT);
exports = module.exports = app;
