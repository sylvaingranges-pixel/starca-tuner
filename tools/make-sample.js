/* Generates a small synthetic Garmin-style GPX so the test-suite doesn't need
 * a real (personal) activity file.  node tools/make-sample.js
 */
const fs = require('fs'), path = require('path');
const out = path.join(__dirname, '..', 'sample', 'sample-ride.gpx');
const start = Date.UTC(2026, 4, 17, 7, 30, 0);
const N = 2400;                       // 40 min at 1 Hz
const lat0 = 46.1000, lon0 = 7.0700;
const R = 6371008.8, DEG = Math.PI / 180;

let lat = lat0, lon = lon0, ele = 460, heading = 0.4;
const pts = [];
for (let i = 0; i < N; i++) {
  const phase = i / N;
  // flat -> climb -> descent -> flat, with a stop around 55 %
  let grade = phase < 0.2 ? 0.005 : phase < 0.5 ? 0.06 + 0.02 * Math.sin(i / 90)
    : phase < 0.75 ? -0.05 : 0.01;
  let v = phase < 0.2 ? 8.5 : phase < 0.5 ? 3.6 : phase < 0.75 ? 13 : 8;
  v *= 1 + 0.05 * Math.sin(i / 37);
  const stopped = i > 1300 && i < 1360;
  if (stopped) v = 0;
  heading += 0.004 * Math.sin(i / 55) + 0.0015 * Math.sin(i / 13);
  const d = v;                                        // 1 s steps
  const jitter = () => (Math.random() - 0.5) * 1.2;   // ~1 m of GPS noise
  const dx = d * Math.cos(heading) + jitter(), dy = d * Math.sin(heading) + jitter();
  lat += (dy / R) / DEG;
  lon += (dx / (R * Math.cos(lat * DEG))) / DEG;
  ele += grade * d;
  const hr = Math.round(120 + 45 * Math.max(0, grade) / 0.08 + 6 * Math.sin(i / 60) + (stopped ? -20 : 0));
  const cad = stopped ? 0 : Math.round(78 + 10 * Math.sin(i / 44));
  const pw = stopped ? 0 : Math.round((0.005 * 83 * 9.81 + 83 * 9.81 * grade) * v + 0.5 * 1.2 * 0.32 * v ** 3);
  const temp = (18 + 3 * phase).toFixed(1);
  // a 90 s recording pause in the middle of the stop
  const skip = i > 1310 && i < 1400;
  if (skip) continue;
  pts.push(
`      <trkpt lat="${lat.toFixed(10)}" lon="${lon.toFixed(10)}">
        <ele>${ele.toFixed(2)}</ele>
        <time>${new Date(start + i * 1000).toISOString()}</time>
        <extensions>
          <ns3:TrackPointExtension>
            <ns3:atemp>${temp}</ns3:atemp>
            <ns3:hr>${hr}</ns3:hr>
            <ns3:cad>${cad}</ns3:cad>
            <ns3:power>${Math.max(0, pw)}</ns3:power>
          </ns3:TrackPointExtension>
        </extensions>
      </trkpt>`);
}

const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="Garmin Connect" version="1.1"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/11.xsd"
  xmlns:ns3="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ns2="http://www.garmin.com/xmlschemas/GpxExtensions/v3">
  <metadata>
    <link href="connect.garmin.com">
      <text>Garmin Connect</text>
    </link>
    <time>${new Date(start).toISOString()}</time>
  </metadata>
  <trk>
    <name>Sortie de démonstration</name>
    <type>road_biking</type>
    <trkseg>
${pts.join('\n')}
    </trkseg>
  </trk>
</gpx>
`;
fs.writeFileSync(out, gpx);
console.log('écrit', out, (gpx.length / 1024).toFixed(0), 'ko,', pts.length, 'points');
