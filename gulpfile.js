var gulp = require('gulp');
// var util = require('gulp-util');
var autoprefixer = require('gulp-autoprefixer');
var sass = require('gulp-sass');
var sourcemaps = require('gulp-sourcemaps');
// var coffee = require('gulp-coffee');

var paths = {
  // scripts: {
  //   src:  'src/coffee/**/*.coffee',
  //   dest: 'public/javascripts'
  // },
  styles: {
    src: 'src/sass/**/*.scss',
    dest: 'public/stylesheets',
  },
};

// gulp.task('scripts', function() {
//   return gulp.src(paths.scripts.src)
//     .pipe(coffee())
//     .pipe(gulp.dest(paths.scripts.dest));
// });

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

gulp.task('default', ['styles', 'watch']);
