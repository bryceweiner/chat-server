'use strict';
var debug = require('debug')('app:server');
var assert = require('better-assert');
var app = require('koa')();
var http = require('http').createServer(app.callback());
var io = require('socket.io')(http);
var request = require('request');
var _ = require('lodash');

var MoneyPot = function(opts) {
  this.endpoint = opts.endpoint;
  this.app_id = opts.app_id;
  this.app_secret = opts.app_secret;

  var self = this;

  this.sendAPIRequest = function(method, endpoint, cb) {
    var uri = this.endpoint + endpoint + '?app_secret=' + self.app_secret;
    debug('Sending request to uri: %s', uri);

    request({
      method: method,
      uri: uri
    }, function(err, response, body) {
      if (err) {
        debug('err', err);
        return cb(err);
      }
      return cb(null, JSON.parse(body));
    });
  };

  this.findAppById = function(app_id, cb) {
    self.sendAPIRequest('GET', '/apps/' + app_id, function(err, app) {
      return cb(err, app);
    });
  };

  this.findUserByTokenHash = function(hash, cb) {
    self.sendAPIRequest('GET', '/hashed-token-users/' + hash, function(err, user) {
      debug('[findUserByTokenHash] user: %j', user);
      return cb(err, user);
    });
  };
};

var api = new MoneyPot({
  endpoint: 'http://localhost:3000/v1',
  app_id: 1007,
  app_secret: '3fc58b9e-3426-4705-9ad8-85ca32603d4b'
});

var Client = function(server, socket, room, user) {
  if (user) {
    debug('[client] creating client with user in room %j', room);
  } else {
    debug('[client] creating client withOUT user %j', room);
  }

  // Initialize
  this.server = server; // required
  this.socket = socket; // required
  // TODO: Change to roomName
  this.room   = room;   // required
  // user is { id: Int, uname: String, role: String }
  // role is mod | admin | member
  this.user   = user;   // optional

  // Join room
  this.socket.join(this.room);

  var self = this;

  this.broadcast = function(event, data) {
    debug('[Client#broadcast] event: %j, data: %j', event, data);
    assert(typeof event === 'string');
    assert(typeof data === 'object');

    io.to(self.room).emit(event, data);
  };

  this.socket.on('new_message', function(text, cb) {

    // Validation

    // User must be auth'd
    if (self.user === undefined) {
      cb('USER_REQUIRED');
      return;
    }

    // User must not be muted
    if (self.server.rooms[self.room].muteList[self.user.uname.toLowerCase()]) {
      self.broadcast('system_message', 'User muted');
      return;
    }

    // text required
    if (typeof text !== 'string') {
      self.socket.emit('client_error',
                       '`new_message` requires string as first argument');
      return;
    }

    text = text.trim();

    if (1 > text.length >= 140) {
      self.socket.emit('client_error', '`new_message` text must be 1-140 chars');
      return;
    }

    if (cb && typeof cb !== 'function') {
      self.socket.emit('client_error', '`new_message` requires a callback');
      return;
    }

    // Validation success

    debug('[client] new_message:', text);

    var textWasCommand;

    if (text.startsWith('/unmute')) {
      textWasCommand = true;
      let unmuteRegexp = /^\/unmute ([a-z0-9_]+)$/i;

      // TODO: Validate uname
      // TODO: Ensure mods cannot mute MPStaff or Owners
      // TODO: Ensure owners cannot mute MPStaff
      // TODO: Ensure MPStaff cannot mute MPStaff
      // TODO: Ensure uname keys are lowercase

      if (unmuteRegexp.test(text)) {
        debug('valid unmute');
        let match = text.match(unmuteRegexp);
        let uname = match[1];
        // Check if uname is muted
        if (self.server.rooms[self.room].muteList[uname.toLowerCase()]) {
          delete self.server.rooms[self.room].muteList[uname.toLowerCase()];
          self.broadcast('user_unmuted', { uname: uname.toLowerCase() });
          self.socket.emit('system_message', 'User "'+ uname.toLowerCase() +'" unmuted');
          return;
        } else {
          self.socket.emit('system_message', 'User "'+ uname.toLowerCase() +'" not in mutelist');
          return;
        }
      } else {
        self.socket.emit('system_message', 'Invalid unmute command');
        return;
      }
    }

    // TODO: Ensure user is owner/mod/admin
    if (text.startsWith('/mute')) {
      textWasCommand = true;
      console.log('starts with /mute');
      if (/\/mute [a-z0-9_]+ [\d]+/.test(text)) {
        // Mute
        let match = text.match(/^\/mute ([a-z0-9_]+) ([\d]+)$/i);
        let uname = match[1]; // TODO: validate
        let mins = Number.parseInt(match[2], 10);  // TODO: handle massive numbers. validate
        // TODO: Convert to iso string
        let date = new Date(Date.now() + (1000 * 60 * mins));
        let muteObj = {
          uname: uname,
          mins: mins,
          expires_at: date
        };
        self.server.rooms[self.room].muteList[uname] = muteObj;
        debug('muteList is now:', self.server.rooms[self.room].muteList);
        self.broadcast('user_muted', muteObj);
        return;
      } else {
        self.socket.emit('system_message', 'Invalid mute command');
        return;
      }
    }

    if (!textWasCommand) {
      self.server.insertMessage(self.room, self.user, text, function(err, message) {
        if (err) {
          cb('INTERNAL_ERROR');
          return;
        }

        self.broadcast('new_message', message);

        // Let user know the message was inserted successfully
        if (cb) {
          cb();
          return;
        }
      });
    }

  });

};

var Server = function() {
  // Map of RoomString -> Object
  this.rooms = {};

  // Map socketId to Client instance
  this.clients = {};

  // Map of Uname to UserObj
  this.users   = {};

  var self = this;

  setInterval(function() {
    debug(
      '[server heartbeat] client count: %j, user count: %j, unames: %j, rooms: %j',
      Object.keys(self.clients).length,
      Object.keys(self.users).length,
      _.values(self.users).map(function(c) { return c.uname; }),
      _.values(self.rooms).map(function(r) {
        var tmp = _.clone(r);
        delete tmp.history;
        return tmp;
      })
    );
  }, 5000);

  this.addClient = function(client, cb) {
    debug('[server] adding client. room pre-add: %j', self.rooms[client.room]);

    // Create room if it doesn't yet exist
    if (!self.rooms[client.room]) {
      debug('room %j did not exist, creating...', client.room);
      self.rooms[client.room] = {
        // Map of uname -> Date
        muteList: {},
        users: {},
        clients: {},
        history: [
          {
            id: 42,
            user: {
              uname: 'test_owner',
              role: 'owner'
            },
            text: ':)'
          }
        ]
      };
    }

    debug('room is now: %j', self.rooms[client.room]);

    // TODO:Add client to rooms map

    // TODO:Add user to users map if fresh
    if (client.user) {
      var user;
      if (self.users[client.user.uname]) {
        debug('[addClient] %s is not fresh', client.user.uname);
        // user is not fresh
        user = self.users[client.user.uname];
        //user.clients[client.socket.id] = client;
      } else {
        debug('[addClient] %s is fresh', client.user.uname);
        // user is fresh
        user = client.user;
        // user.clients = {};
        // user.clients[client.socket.id] = client;
        self.rooms[client.room].users[client.user.uname] = client.user;
        io.to(client.room).emit('user_joined', client.user);
      }

      self.users[client.user.uname] = user;
    }

    this.clients[client.socket.id] = client;

    // State configured, so now send initialization payload to the
    // client's `auth` callback.
    var initPayload = {
      user: client.user,
      room: self.rooms[client.room]
    };
    cb(null, initPayload);

  };

  this.removeSocket = function(socket) {
    var client = self.clients[socket.id];

    if (client) {
      debug('[removeSocket] client: %j', client.socket.id);
    } else {
      debug('[removeSocket] no client found for socket.id: %j', socket.id);
    }

    // debug('[removeSocket] client: %j', client.socket.id);
    delete self.clients[socket.id];

    if (client.user) {

      // Does user still have any connected clients?
      // TODO: Need to check if user has any clients *in the room this client just
      // left*
      var aRemainingClient = _.values(self.clients).some(function(c) {
        return c.user.uname === client.user.uname &&
               c.room === client.room;
      });

      if (aRemainingClient) {
        debug('aRemainingClient: ', aRemainingClient);
      } else {
        // User has no more clients
        debug('NO REMAINING CLIENTS');

        // Remove the user
        delete self.users[client.user.uname];

        // Remove user from room too
        delete self.rooms[client.room].users[client.user.uname];

        // Tell room user has left
        io.to(client.room).emit('user_left', client.user);
      }
    }

  };

  this.insertMessage = function(roomName, user, text, cb) {
    debug('[Server#insertMessage] user: %j, text: %j', user, text);

    var message = {
      id: Math.random(),
      user: {
        uname: user.uname,
        role: user.role
      },
      text: text
    };

    self.rooms[roomName].history.push(message);

    cb(null, message);
  };
};

var server = new Server();

io.on('connect', function(socket) {
  debug('[connect] a user connected:', socket.id);

  socket.on('error', function(err) {
    debug('socket error:', err);
  });

  // data is { app_id: Int, token_hash: Maybe String }
  socket.once('auth', function(data, cb) {
    console.log('socket auth:', data);

    // Validate

    // Auth must provide object payload
    if (typeof data !== 'object') {
      socket.emit('client_error', 'must send data object with `auth` event');
      return;
    }

    // Auth must provide app_id
    if (typeof data.app_id !== 'number') {
      socket.emit('client_error', 'must send app_id integer with `auth` event');
      return;
    }

    if (typeof cb !== 'function') {
      // Emit to socket since they didn't provide a callback
      socket.emit('client_error', 'must provide callback to `auth` event');
      return;
    }

    // Validation success

    api.findAppById(data.app_id, function(err, app) {
      if (err) {
        console.error('[findAppById] Error:', err, err.stack);
        cb('INTERNAL_ERROR');
        return;
      }

      // If client doesn't give us
      if (!app) {
        socket.emit('client_error', 'no app found with the app_id you sent to `auth` event');
        return;
      }

      // App found
      var room = 'app:' + app.id;

      // if hash not given, then create client without user
      if (typeof data.token_hash !== 'string') {
        debug('no token_hash given');
        server.addClient(new Client(server, socket, room), cb);
        return;
      }

      api.findUserByTokenHash(data.token_hash, function(err, user) {
        //if (err) { throw new Error('error:', err); }
        if (err) {
          console.error('[findUserByTokenHash] Error:', err, err.stack);
          cb('INTERNAL_ERROR');
          return;
        }

        // if hash didn't resolve to user, create client without user
        if (typeof user !== 'object') {
          server.addClient(new Client(server, socket, room), cb);
          return;
        }

        // User found, so create client with user
        server.addClient(new Client(server, socket, room, user), cb);
      });
    });

  });

  socket.on('disconnect', function() {
    debug('[disconnect] socket disconnected');
    server.removeSocket(socket);
  });
});

http.listen(3001, function() {
  console.log('Listening on 3001');
});
