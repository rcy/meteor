var fs = Npm.require('fs');
var Future = Npm.require('fibers/future');


var MONITOR_INTERVAL = 5*1000; // every 5 seconds
var readFile = Meteor._wrapAsync(fs.readFile);

var writeFile = Meteor._wrapAsync(fs.writeFile);

Follower = {
  connect: function (urlSet, options) {
    var electorTries;
    options = _.extend({
      group: "package.leadershipLivedata"
    }, options);
    // start each elector as untried/assumed connectable.

    // for options.priority, low-priority things are tried first.
    var makeElectorTries = function (urlSet, options) {
      if (options.reset || !electorTries)
        electorTries = {};
      if (typeof urlSet === 'string') {
        urlSet = _.map(urlSet.split(','), function (url) {return url.trim();});
      }
      _.each(urlSet, function (url) {
        electorTries[url] = options.priority || 0;
      });
    };
    if (options.file) {
      var contents;
      try {
        contents = readFile(options.file, 'utf8');
      } catch (e) {
        console.log("no file to read electors out of");
      }
      if (contents)
        makeElectorTries(contents, { priority: 0, reset: true });
      makeElectorTries(urlSet, {priority: 1, reset: false});
    } else {
      makeElectorTries(urlSet, { priority: 0, reset: true });
    }
    var tryingUrl = null;
    var outstandingGetElectorate = false;
    var conn = null;
    var leader = null;
    var connected = null;
    var intervalHandle = null;


    // Used to defer all method calls until we're sure that we connected to the
    // right leadership group.
    var connectedToLeadershipGroup = new Future();

    var lost = false;
    var lostCallbacks = [];
    var foundCallbacks = [];

    var findFewestTries = function () {
      var min = 10000;
      var minElector = null;
      _.each(electorTries, function (tries, elector) {
        if (tries < min) {
          min = tries;
          minElector = elector;
        }
      });
      if (min > 1 && !lost) {
        // we've tried everything once; we just became lost.
        lost = true;
        _.each(lostCallbacks, function (f) { f(); });
      }
      return minElector;
    };

    var updateElectorate = function (res) {
      leader = res.leader;
      _.each(electorTries, function (state, elector) {
        if (!_.contains(res.electorate, elector)) {
          delete electorTries[elector];
        }
      });
      _.each(res.electorate, function (elector) {
        electorTries[elector] = 0; // verified that this is in the current elector set.
      });
      if (options.file) {
        writeFile(options.file, res.electorate.join(','), 'utf8');
      }
    };

    var tryElector = function (url) {
      if (tryingUrl) {
        electorTries[tryingUrl]++;
      }
      url = url || findFewestTries();
      //console.log("trying", url, electorTries, tryingUrl, process.env.GALAXY_JOB);

      // Don't keep trying the same url as fast as we can if it's not working.
      if (electorTries[url] > 2) {
        Meteor._sleepForMs(3 * 1000);
      }

      if (conn) {
        conn._reconnectImpl({
          url: url
        });
      } else {
        conn = DDP.connect(url);
        conn._reconnectImpl = conn.reconnect;
      }
      tryingUrl = url;

      if (!outstandingGetElectorate) {
        outstandingGetElectorate = true;
        conn.call('getElectorate', options.group, function (err, res) {
          outstandingGetElectorate = false;
          connected = tryingUrl;
          if (!_.contains(res.electorate, connected)) {
            Log.warn("electorate " + res.electorate + " does not contain " + connected);
          }
          if (err) {
            tryElector();
            return;
          }
          tryingUrl = null;
          if (! connectedToLeadershipGroup.isResolved()) {
            connectedToLeadershipGroup["return"]();
          }
          // we got an answer!  Connected!
          electorTries[url] = 0;

          if (res.leader === connected) {
            // we're good.
            if (lost) {
              // we're found.
              lost = false;
              _.each(foundCallbacks, function (f) { f(); });
            }
          } else {
            // let's connect to the leader anyway, if we think it
            // is connectable.
            if (electorTries[res.leader] == 0) {
              tryElector(res.leader);
            } else {
              // XXX: leader is probably down, we're probably going to elect
              // soon.  Wait for the next round.
            }

          }
          updateElectorate(res);
        });
      }

    };

    tryElector();

    var checkConnection = function () {
      if (conn.status().status !== 'connected' || connected !== leader) {
        tryElector();
      } else {
        conn.call('getElectorate', options.group, function (err, res) {
          if (err) {
            electorTries[connected]++;
            tryElector();
          } else if (res.leader !== leader) {
            // update the electorate, and then definitely try to connect to the leader.
            updateElectorate(res);
            tryElector(res.leader);
          } else {
            if (! connectedToLeadershipGroup.isResolved()) {
              connectedToLeadershipGroup["return"]();
            }
            //console.log("updating electorate with", res);
            updateElectorate(res);
          }
        });
      }
    };

    var monitorConnection = function () {
      return Meteor.setInterval(checkConnection, MONITOR_INTERVAL);
    };

    intervalHandle = monitorConnection();


    var prevDisconnect = conn.disconnect;
    conn.disconnect = function () {
      if (intervalHandle)
        Meteor.clearInterval(intervalHandle);
      intervalHandle = null;
      prevDisconnect.apply(conn);
    };

    conn.reconnect = function () {
      if (!intervalHandle)
        intervalHandle = monitorConnection();
      if (arguments[0] && arguments[0].url) {
        makeElectorTries(arguments[0].url, {reset: true, priority: 0});
        tryElector();
      } else {
        conn._reconnectImpl.apply(conn, arguments);
      }
    };

    conn.getUrl = function () {
      return _.keys(electorTries).join(',');
    };

    conn.tries = function () {
      return electorTries;
    };


    // Assumes that `call` is implemented in terms of `apply`. All method calls
    // should be deferred until we are sure we've connected to the right
    // leadership group.
    conn._applyImpl = conn.apply;
    conn.apply = function (/* arguments */) {
      var args = _.toArray(arguments);
      if (typeof args[args.length-1] === 'function') {
        // this needs to be independent of this fiber if there is a callback.
        Meteor.defer(function () {
          connectedToLeadershipGroup.wait();
          return conn._applyImpl.apply(conn, args);
        });
        return null; // if there is a callback, the return value is not used
      } else {
        connectedToLeadershipGroup.wait();
        return conn._applyImpl.apply(conn, args);
      }
    };

    conn.onLost = function (callback) {
      lostCallbacks.push(callback);
    };

    conn.onFound = function (callback) {
      foundCallbacks.push(callback);
    };

    return conn;

  }
};