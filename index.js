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

/*
 * Parse the name of the brewery from a guest ale (otherwise it's BrewDog).
 */
function getBreweryAndStrength(brew) {
  var brewWithData = {};
  var entities = new htmlEntities.AllHtmlEntities();
  var isBrewDog = false;

  var brewMatches = entities.decode(brew).match(/(.*) - (.*) (\d+\.?\d*%)/);
  if (!brewMatches) {
    brewMatches = brew.match(/(.*) (\d+\.?\d*%)/);
    isBrewDog = true;
  }

  brewWithData.brewery = isBrewDog ? 'BrewDog' : brewMatches[1].trim();
  brewWithData.name = isBrewDog ? brewMatches[1].trim() : brewMatches[2].trim();
  brewWithData.strength = isBrewDog ? brewMatches[2] : brewMatches[3];

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

  // Brutely check through each brew type.
  Object.keys(brews).forEach(function(brewType) {
    brewList.forEach(function(item, index) {
      if (ranges[brewType] &&
          index >= ranges[brewType][0] && index <= ranges[brewType][1]) {
        brews[brewType].push(getBreweryAndStrength(item));
      }
    });
  });

  return brews;
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

    reply = false;

    // No cached data exists or it's outdated; fetch new data!
    if (!reply || reply.expiryTime < now) {
      var url = 'https://www.brewdog.com/bars/' + country + '/' + pub;

      request(url, function(err, response, html) {
        if (err) {
          res.send({ error: 'Unknown error' });;
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
