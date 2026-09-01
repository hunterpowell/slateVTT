// The status page. Deliberately ES5 and deliberately XMLHttpRequest: the
// eventual reader is a jailbroken Kindle's browser, which is old, and none of
// what this page does is worth a polyfill or a build step. See README.md.
(function () {
  'use strict';

  function param(name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(window.location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }

  var KEY = param('key');
  // A full repaint flashes an e-ink panel, so a wall display wants ?every=60.
  // The window on a desk wants to be current, which is what the default is for.
  var EVERY = Math.max(5, parseInt(param('every'), 10) || 15) * 1000;

  var root = document.getElementById('root');
  var good = null; // the last payload that arrived whole
  var goodAt = 0; // Date.now() when it did
  var problem = null; // why the most recent attempt failed, or null

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Coarse on purpose: an ops window is read at a glance, and "5d 22h" is the
  // whole of what anyone wants from an uptime.
  function duration(s) {
    s = Math.max(0, Math.round(s));
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
    var m = Math.floor((s % 3600) / 60);
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm';
    return s + 's';
  }

  // Compact on purpose: a locale string wraps to two lines in a 220px card,
  // and the year is never the thing being asked about here.
  function stamp(unix) {
    if (!unix) return 'unknown';
    var d = new Date(unix * 1000);
    if (isNaN(d.getTime())) return 'unknown';
    function two(n) { return (n < 10 ? '0' : '') + n; }
    return two(d.getDate()) + '/' + two(d.getMonth() + 1) + ' ' +
      two(d.getHours()) + ':' + two(d.getMinutes());
  }

  function row(label, value, alarm) {
    var shown = alarm ? '<span class="alarm">' + esc(value) + '</span>' : esc(value);
    return '<tr><td>' + esc(label) + '</td><td class="num">' + shown + '</td></tr>';
  }

  function card(title, body, wide) {
    return '<div class="card' + (wide ? ' wide' : '') + '">' +
      '<h2>' + esc(title) + '</h2>' + body + '</div>';
  }

  function whoIsHere(here) {
    if (!here || !here.length) return null;
    var names = [];
    for (var i = 0; i < here.length; i++) {
      names.push(here[i].kind === 'dm' ? 'DM' : here[i].id);
    }
    return names.join(', ');
  }

  var TBODY_OPEN = '<table><tbody>';
  var TBODY_CLOSE = '</tbody></table>';

  // --- fetching -----------------------------------------------------------

  function poll() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/status?key=' + encodeURIComponent(KEY), true);
    xhr.timeout = 10000;
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status === 200) {
        try {
          good = JSON.parse(xhr.responseText);
          goodAt = Date.now();
          problem = null;
        } catch (e) {
          problem = 'the server answered with something that is not JSON';
        }
      } else if (xhr.status === 403) {
        problem = 'the status key was refused';
      } else if (xhr.status === 404) {
        // The route is not mounted when SLATE_STATUS_KEY is unset, so this is a
        // configuration answer rather than a wrong-key one. Worth separating:
        // they send you to different files.
        problem = 'this server has no status endpoint — SLATE_STATUS_KEY is unset';
      } else if (xhr.status === 0) {
        problem = 'no answer from the server';
      } else {
        problem = 'the server answered ' + xhr.status;
      }
      draw();
    };
    xhr.send();
  }

  // --- drawing ------------------------------------------------------------

  // Three states, not two. `pending` is deliberately *not* inverted: a change
  // inside the two-second debounce is what a healthy room in use looks like,
  // and an alarm that fires on the ordinary case is one you learn to ignore.
  // Inversion is reserved for the write that is actually failing.
  function savedCell(r, serverNow, alarms) {
    if (r.saves_failing) {
      var since = serverNow && r.last_saved_unix
        ? 'last good write ' + duration(Math.max(0, serverNow - r.last_saved_unix)) + ' ago'
        : 'nothing written since the server started';
      alarms.push(r.name + ': SAVES FAILING, ' + since);
      return '<span class="alarm">FAILING</span>';
    }
    return r.unsaved ? 'pending' : 'yes';
  }

  function roomsTable(rooms, serverNow, alarms) {
    var body = '';
    for (var i = 0; i < rooms.length; i++) {
      var r = rooms[i];
      if (!r.responding) {
        alarms.push(r.name + ' is not responding');
        body += '<tr><td class="name">' + esc(r.name) + '</td>' +
          '<td colspan="4"><span class="alarm">DID NOT ANSWER</span></td></tr>';
        continue;
      }
      var here = whoIsHere(r.here);
      body += '<tr><td class="name">' + esc(r.name) + '</td>' +
        '<td>' + (here ? esc(here) : '<span class="quiet">empty</span>') + '</td>' +
        '<td class="num">' + r.sockets + '</td>' +
        '<td class="num">' + r.tokens + '</td>' +
        '<td class="num">' + savedCell(r, serverNow, alarms) + '</td></tr>';
    }
    if (!body) body = '<tr><td colspan="5" class="quiet">No rooms.</td></tr>';
    return '<table><thead><tr><th>Room</th><th>Here</th>' +
      '<th class="num">Sockets</th><th class="num">Tokens</th>' +
      '<th class="num">Saved</th></tr></thead><tbody>' + body + TBODY_CLOSE;
  }

  function serverCard(server, host, alarms) {
    var out = TBODY_OPEN +
      row('Version', (server && server.version) || '?', false) +
      row('Uptime', duration((server && server.uptime_s) || 0), false) +
      row('Since', stamp(server && server.started_unix), false);
    // From the collector, because systemd knows this and Slate does not. Sits
    // here rather than in the host card because it is about the service: read
    // next to Uptime, a number here is what separates "it crashed" from "you
    // deployed".
    if (host && typeof host.restarts === 'number') {
      if (host.restarts > 0) {
        alarms.push('slate has restarted itself ' +
          host.restarts + (host.restarts === 1 ? ' time' : ' times'));
      }
      out += row('Restarts', String(host.restarts), host.restarts > 0);
    }
    return out + TBODY_CLOSE;
  }

  function hostCard(host, serverNow, alarms) {
    if (!host) return '<p class="quiet">No collector on this machine.</p>';
    if (host.error) {
      alarms.push('host collector is broken');
      return '<p><span class="alarm">BROKEN</span> ' + esc(host.error) + '</p>';
    }

    // A dead timer leaves a file that still parses. Age is the only thing that
    // catches it, which is why the collector stamps every write.
    var age = serverNow && host.at ? Math.max(0, serverNow - host.at) : null;
    var stale = age !== null && age > 300;
    if (stale) alarms.push('host readings are ' + duration(age) + ' old');
    if (host.undervoltage) alarms.push('undervoltage');
    var hot = typeof host.cpu_c === 'number' && host.cpu_c >= 75;
    if (hot) alarms.push('CPU at ' + host.cpu_c + '°C');
    var full = typeof host.disk_pct === 'number' && host.disk_pct >= 90;
    if (full) alarms.push('disk ' + host.disk_pct + '% full');

    var out = TBODY_OPEN;
    if (typeof host.cpu_c === 'number') {
      out += row('CPU', host.cpu_c.toFixed(1) + '°C', hot);
    }
    if (typeof host.load1 === 'number') {
      out += row('Load', host.load1.toFixed(2), false);
    }
    if (host.mem_total_mb) {
      out += row('Memory', host.mem_used_mb + ' / ' + host.mem_total_mb + ' MB', false);
    }
    if (host.disk_total_gb) {
      out += row('Disk', host.disk_used_gb + ' / ' + host.disk_total_gb +
        ' GB (' + host.disk_pct + '%)', full);
    }
    if (typeof host.uploads_mb === 'number') {
      var files = typeof host.uploads_files === 'number'
        ? ' / ' + host.uploads_files + ' files'
        : '';
      out += row('Uploads', host.uploads_mb + ' MB' + files, false);
    }
    if (host.uptime_s) out += row('Host up', duration(host.uptime_s), false);
    // Three states, not two: a board that browned out overnight and recovered
    // reads 'ok' by the time anyone looks, and that is the reading worth having.
    var power = host.undervoltage
      ? 'UNDERVOLTAGE'
      : (host.undervoltage_ever ? 'ok (dipped)' : 'ok');
    out += row('Power', power, !!host.undervoltage);
    // Only once it is worth knowing. A fresh reading is the ordinary case, and
    // on a panel with no spare lines a row that always says "20s old" is the
    // one to give up for the two above.
    if (age !== null && age > 90) out += row('Read', duration(age) + ' old', stale);
    return out + TBODY_CLOSE;
  }

  // Rendered generically so whatever the deploy chooses to stamp shows up
  // without this file having to be edited to match it.
  function buildCard(build) {
    if (!build) return '<p class="quiet">No build stamp.</p>';
    var out = TBODY_OPEN;
    for (var k in build) {
      if (!Object.prototype.hasOwnProperty.call(build, k)) continue;
      var v = build[k];
      if (/_unix$/.test(k) && typeof v === 'number') v = stamp(v);
      else if (typeof v === 'boolean') v = v ? 'yes' : 'no';
      out += row(k.replace(/_unix$/, '').replace(/_/g, ' '), v, k === 'dirty' && build[k] === true);
    }
    return out + TBODY_CLOSE;
  }

  function draw() {
    if (!KEY) {
      root.innerHTML = '<div class="down"><div class="big">NO KEY</div>' +
        '<div class="why">Open this page with the status key in the URL:<br>' +
        '<code>/status/?key=&lt;SLATE_STATUS_KEY&gt;</code></div></div>';
      return;
    }

    var alarms = [];
    // The server's own clock, not the browser's. Everything below that ages
    // something is measured against this, so a laptop with a wrong clock cannot
    // make the Pi look stale.
    var serverNow = good && good.server
      ? (good.server.started_unix || 0) + (good.server.uptime_s || 0)
      : 0;

    // **All four before the verdict is decided.** Each card contributes to
    // `alarms`, and the strip that renders them is written out below — a card
    // built after it would invert a number on the screen with nothing anywhere
    // saying why, which is how the restart count first shipped.
    var roomsHtml = roomsTable((good && good.rooms) || [], serverNow, alarms);
    var hostHtml = hostCard(good ? good.host : null, serverNow, alarms);
    var serverHtml = serverCard(good ? good.server : null, good ? good.host : null, alarms);
    var buildHtml = buildCard(good ? good.build : null);

    var verdict = problem ? 'UNREACHABLE' : (alarms.length ? 'ATTENTION' : 'OK');
    var ageText = goodAt ? duration((Date.now() - goodAt) / 1000) + ' ago' : 'never';

    var html = '<div class="bar"><h1>Slate</h1><span class="verdict' +
      (verdict === 'OK' ? '' : ' alarm') + '">' + verdict + '</span>' +
      '<span class="age">updated ' + esc(ageText) + '</span></div>';

    // The most important state this page has. It shows the last good data
    // underneath rather than instead, because "it was fine 20 seconds ago" and
    // "it has been gone an hour" are different emergencies.
    if (problem) {
      html += '<div class="down"><div class="big">UNREACHABLE</div>' +
        '<div class="why">' + esc(problem) +
        (goodAt
          ? '<br>Last good reading ' + esc(duration((Date.now() - goodAt) / 1000)) + ' ago.'
          : '<br>Nothing has ever been read from this server.') +
        '</div></div>';
    } else if (alarms.length) {
      html += '<div class="alarms"><span class="alarm">' +
        esc(alarms.join(' · ')) + '</span></div>';
    }

    if (good) {
      html += '<div class="grid">' +
        card('Rooms', roomsHtml, true) +
        card('Server', serverHtml, false) +
        card('Host', hostHtml, false) +
        card('Build', buildHtml, false) +
        '</div>';
    }

    root.innerHTML = html;
  }

  draw();
  if (KEY) {
    poll();
    setInterval(poll, EVERY);
    // Between polls, so "updated 4s ago" keeps counting rather than sitting
    // still and looking like the page itself has frozen.
    setInterval(function () { if (good || problem) draw(); }, 1000);
  }
})();
