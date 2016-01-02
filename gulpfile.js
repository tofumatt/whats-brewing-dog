var packageJSON = require('./package.json');

var gulp = require('gulp');
var autoprefixer = require('gulp-autoprefixer');
var gls = require('gulp-live-server');
var sass = require('gulp-sass');
var sourcemaps = require('gulp-sourcemaps');

var paths = {
  styles: {
    src: 'src/sass/**/*.scss',
    dest: 'public/stylesheets',
  },
};

gulp.task('serve', function() {
  var server = gls.new(packageJSON.main);
  server.start();

  // Use gulp.watch to trigger server actions (notify, start or stop)
  gulp.watch(['public/**/*.css', 'public/**/*.html'], function(file) {
    server.notify.apply(server, [file]);
  });

  // Restart the server.
  gulp.watch(packageJSON.main, function() {
    server.start.bind(server)();
  });
});

gulp.task('styles', function() {
  return gulp.src(paths.styles.src)
    .pipe(sourcemaps.init())
    .pipe(sass({
      includePaths: ['node_modules/bootstrap-sass/assets/stylesheets'],
    }).on('error', sass.logError))
    .pipe(autoprefixer({
      browsers: ['last 2 versions'],
      cascade: false,
    }))
    .pipe(sourcemaps.write())
    .pipe(gulp.dest(paths.styles.dest));
});

gulp.task('watch', function() {
  // gulp.watch(paths.scripts.src, ['scripts']);
  gulp.watch(paths.styles.src, ['styles']);
});

gulp.task('default', ['styles', 'serve', 'watch']);
