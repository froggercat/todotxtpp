
var DropboxOAuth2Strategy = require('passport-dropbox-oauth2').Strategy,
  path = require('path'),
  fs = require('fs'),
  _ = require('underscore'),
  passport = require('passport'),
  DropboxJS = require('dropbox'),
  Q = require('q'),
  merge = require('../../public/js/merge');

var Dropbox = function(UserClass, ListClass){
  this.$UserClass = UserClass;
  this.$ListClass = ListClass;

  this.$dropboxSettings = {};
  if (process.env.TODO_DROPBOX_KEY){
    this.$dropboxSettings.key = process.env.TODO_DROPBOX_KEY;
  }

  if (process.env.TODO_DROPBOX_SECRET){
    this.$dropboxSettings.secret = process.env.TODO_DROPBOX_SECRET;
  }

  if (this.$dropboxSettings.key && this.$dropboxSettings.secret){
    return;
  }

  // Read in the dropbox app settings.
  if (!fs.existsSync(path.join(__dirname, '../../dropbox.json'))){
    logger.error("Can't find the 'dropbox.json' file.");
    process.exit(1);
  }

  this.$dropboxSettings = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../../dropbox.json'), { encoding : 'utf-8' }));

  if (!_.has(this.$dropboxSettings, 'key') || ! _.has(this.$dropboxSettings, 'secret')){
    logger.error("'dropbox.json' must provide a key and a secret.");
    process.exit(1);
  }
};
module.exports = Dropbox;

(function(){
  this.getRevision_p = function(path, client){
    var deferred = Q.defer();
    client.stat(path, function(err, stat){
      if (err){
        deferred.reject(err);
      }
      var rev = stat._json.revision;
      deferred.resolve(rev);
    });
    return deferred.promise;
  }

  this.writeFile_p = function(path, text, revision, client){
    return this.getRevision_p(path, client)
    .then(function(rev){
      var deferred = Q.defer();

      //TODO: Can't you specify the revision on write rather than async?
      if (rev > revision){
        throw new Error("Someone has modified this file since you last opened it.");
      }
      client.writeFile(path, text, function(error, stat) {
        if (error) {
          deferred.reject(error);
        }
        deferred.resolve({
          revision: stat._json ? stat._json.revision : undefined, 
          versionTag: stat.versionTag
        });
      });
      return deferred.promise;
    });
  }

  this.fetchRemoteList_p = function(req, client){
    if (!client){
      client = new DropboxJS.Client({token: req.user.accessToken});
    }
    var deferred = Q.defer();
    logger.trace("Requesting remote file from Dropbox");
    client.readFile(req.user.path, function(error, file, data) {
      if (error) {
        return deferred.reject(err);         
      }
      deferred.resolve({
        dropboxID: req.user.dropboxID,
        revision: data._json ? data._json.revision : undefined,
        text: file
      });
    });
    return deferred.promise;
  }

  this.getList_p = function(req){
    var self = this;
    var deferred = Q.defer();

    logger.trace("Checking storage for list...");
    var list = self.$ListClass.findOne({dropboxID : req.user.dropboxID},
      function(err, list){
        if (err)
          return deferred.reject(err);

        var client = new DropboxJS.Client({token: req.user.accessToken});

        if (list){          
          logger.trace("We have a cached copy. Confirming it's up-to-date...");
          self.getRevision_p(req.user.path, client)
          .then(function(rev){
            if (rev > list.revision){
              logger.trace("Cached copy was out of date. Refreshing...");
              self.fetchRemoteList_p(req, client)
              .then(function(remoteList){
                logger.trace("Caching updated copy and returning.");
                
                self.$ListClass.update({ dropboxID : req.user.dropboxID },
                  { $set: {
                    revision: rev,
                    text: remoteList.text
                  }},
                  function(err, doc){
                    if (err)
                      deferred.reject(err);

                    deferred.resolve(remoteList);    
                  }
                );                
              })
              .done();
            } else{
              logger.trace("It's up-to-date. Returning cached copy.");
              deferred.resolve(list);
            }
          })
          .done();
          return;
        }

        logger.trace("No cached copy. Fetching remote list.");
        self.fetchRemoteList_p(req)
        .then(function(list){
          // Store in cache.
          logger.trace("Storing list in cache and returning.");
          var newList = new self.$ListClass(list);
          newList.save(function(err){
            if (err){
              return deferred.reject(err);              
            }            

            deferred.resolve(list);
          });
        });
        
      });    
    return deferred.promise;
  }

  this.addMiddleware = function(app){
    var self = this;

    var callbackURL = global.DOMAIN;
    callbackURL += '/auth/dropbox/callback';

    passport.use(new DropboxOAuth2Strategy({
        clientID: this.$dropboxSettings.key,
        clientSecret: this.$dropboxSettings.secret,
        callbackURL: callbackURL
      },
      function(accessToken, refreshToken, profile, done) {
        var existingUser = self.$UserClass.findOne({dropboxID : profile.id},
          function(err, user){
            if (err)
              done(err, null);

            if (user){
              // User already existing. Just bind this session to that account
              logger.trace("User with DropboxID already exists.");
              return done(err, user);
            }
            // create from scratch
            logger.debug("New Dropbox user. Creating account.");
            var newUser = new self.$UserClass({
              dropboxID: profile.id,
              email: profile._json.email,
              displayName: profile.displayName,          
              accessToken: accessToken
            });
            newUser.save(function(err){
              done(err, newUser);
            });
          });        
      }
    ));

    app.use('/list', function(req, res, next){
      if (!req.user || !req.user.accessToken){
        return res.send(403);
      }
      if (!req.user || ! req.user.path){
        return res.send(400);
      }
      
      if (req.method === 'GET'){
        self.getList_p(req)
        .then(function(list){
          res.json({text: list.text, revision : list.revision});
        })
        .fail(function(err){
          res.send(500, {errors: [err.message]});
        })
        .done();
        return;
      } else if (req.method==='POST'){
        if (!req.body){
          return res.send(403);
        }
        
        var text = req.body.text;
        if (req.body.filter){
          // We were only given a subset of lines. Merge into the existing doc.
          var doc = 
          text = merge(doc, req.body.filter, req.body.text);
        }

        var client = new DropboxJS.Client({token: req.user.accessToken});
        self.writeFile_p(req.user.path, text, 
          req.body.revision, client)
        .then(function(revs){
          res.json(revs);          
        })
        .fail(function(err){
          res.json({errors: [err.message]});
        })
        .done();
        return;
      }
      res.send(400);
    });

    app.use('/revision', function(req, res, next){
      if (!req.user || !req.user.accessToken){
        return res.send(403);        
      }
      if (!req.user || ! req.user.path){
        return res.send(400);
      }
      var client = new DropboxJS.Client({token: req.user.accessToken});

      self.getRevision_p(req.user.path, client)
      .then(function(rev){
        res.json(rev);
      })
      .fail(function(err){
        res.send(500);
      })
      .done();

    });

    app.get('/login',
      passport.authenticate('dropbox-oauth2'));

    app.get('/auth/dropbox/callback', 
      passport.authenticate('dropbox-oauth2', { failureRedirect: '/login' }),
      function(req, res) {
        res.redirect('/');
      });

  }
}).call(Dropbox.prototype);






  