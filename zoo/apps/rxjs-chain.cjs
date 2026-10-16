// Planted problem: a long RxJS operator chain pushes every item through async plumbing.
const { range, of } = require('rxjs');
const { map: m, filter: f, scan: s, mergeMap: mm, toArray: ta } = require('rxjs/operators');
const { serve } = require('./_drive.cjs');

serve(
  () =>
    new Promise((resolve) => {
      range(0, 40000)
        .pipe(
          m((x) => x * 2),
          f((x) => x % 3 !== 0),
          s((acc, x) => acc + x, 0),
          mm((x) => of(x + 1)),
          m((x) => x - 1),
          f(() => true),
          ta(),
        )
        .subscribe((a) => resolve(a.length));
    }),
  30,
);
