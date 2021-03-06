/**
 * Module dependencies.
 */
var settings = require('./config.js')
    , path = require('path')
    , fs = require('fs');

var express = require('express')
  , app = express()
  , server = require('http').createServer(app)
  , io = require('socket.io').listen(server);

var spawn = require('child_process').spawn
	, child_process = require('child_process')
    , pty = require('pty.js');

var sqlite3 = require('sqlite3').verbose()
	, sessDb = new sqlite3.Database('./sessions.db')
	, userid = require('userid')
	, pam = require('authenticate-pam');
;

sessDb.serialize(function() {
	sessDb.run("CREATE TABLE if not exists sessions ( key text primary key, user text, age TIMESTAMP DEFAULT CURRENT_TIMESTAMP )");
});


// all environments
app.set('port', process.env.TEST_PORT || 8088);
app.use(express.favicon());
app.use(express.logger('dev'));
app.use(express.bodyParser());
app.use(express.methodOverride());
app.use(express.static(path.join(__dirname, 'public')));

//Routes
app.get('/term.js', function (req, res) {
	res.set('Content-Type', 'text/javascript;charset=utf-8');
	res.sendfile(__dirname+'/node_modules/term.js/src/term.js');
});

app.get('/jFresh.js', function (req, res) {
	var tpls = fs.readdirSync(__dirname + '/tpls')
		, data
	;

	res.set('Content-Type', 'text/javascript;charset=utf-8');

	data = fs.readFileSync(__dirname+'/jFresh-client-engine.js', 'utf-8');
	res.write(data);
	res.write("\r\n");

	for(var i=0; i<tpls.length; i++) {
		ext = path.extname(tpls[i]);
		if ( ext != '.js' ) continue;

		data = fs.readFileSync(__dirname + '/tpls/' + tpls[i]);
		res.write(data);
		res.write("\r\n");
	}


	res.end();
});

app.get('/', function (req, res) {
	var jFreshTag = '<!--JFRESH-->'
		, indexTpl = fs.readFileSync(__dirname + '/public/start.html', 'utf-8')
		, idxStart = indexTpl.indexOf(jFreshTag)
		, tpls = fs.readdirSync(__dirname + '/tpls')
		, data , dataWrap , ext;

	res.set('Content-Type', 'text/html;charset=utf-8');
	res.write( indexTpl.substr(0, idxStart) );

	for(var i=0; i<tpls.length; i++) {
		ext = path.extname(tpls[i]);
		if ( ext != '.html' ) continue;

		data = fs.readFileSync(__dirname + '/tpls/' + tpls[i]);
		res.write(data);

		if (dataWrap) {
			res.write(dataWrap);
			dataWrap = false;
		}
	}

	res.write( indexTpl.substr(idxStart+jFreshTag.length) );
	res.end();
});

//Socket.io Config
io.set('log level', 1);

server.listen(app.get('port'), function(){
  console.log('jFresh is running on port ' + app.get('port'));
});

var ss;


function uuid(
  a                  // placeholder
){
  return a           // if the placeholder was passed, return
    ? (              // a random number from 0 to 15
      a ^            // unless b is 8,
      Math.random()  // in which case
      * 16           // a random number from
      >> a/4         // 8 to 11
      ).toString(16) // in hexadecimal
    : (              // or otherwise a concatenated string:
      [1e7] +        // 10000000 +
      -1e3 +         // -1000 +
      -4e3 +         // -4000 +
      -8e3 +         // -80000000 +
      -1e11          // -100000000000,
      ).replace(     // replacing
        /[018]/g,    // zeroes, ones, and eights with
        uuid            // random hex digits
      )
}

//Run and pipe shell script output
function run_shell(cmd, args, cb, end) {
    var spawn = require('child_process').spawn,
        child = spawn(cmd, args),
        me = this;
    child.stdout.on('data', function (buffer) { cb(me, buffer); });
    child.stdout.on('end', end);
}

function on_user_login(socket,usr,uid) {
	var env = process.env;
	var cwd = process.cwd;

	var cp_opt = {
		//in,out,err
		stdio: ['ignore', 'ignore', 'ignore'],
		env: env,
		cwd: cwd,
		detached: false,
		uid: userid.uid(usr),
		gid: userid.gid(usr),
	};
	var child = child_process.fork('jFreshWS.js', [], cp_opt);
	child.on('message', function(m) {
		socket.emit('d', m);
	});
	socket.emit('sessionKey', {user: usr, key: uid});

	sessDb.serialize(function() {
		var stmt = sessDb.prepare("insert or replace into sessions(key,user) values(?,?)");
		stmt.run(uid, usr);
		stmt.finalize();
	});

	socket.on('d', function(m) {
		child.send(m);
	});

	socket.on('disconnect', function() {
		console.log('websocket client gone byebye!');
		if ( child ) {
			child.send({o: 'die'});
		}
	});

}

io.sockets.on('connection', function (socket) {
	//we spawn a new child after socket login with user's crap and start routing from there...
	var userid, uid;
	console.log('New Websocket Connection started!');
	//~ socket.emit('autherror', 'hello world');

	socket.on("login", function(usr,pwd) {
		if ( userid ) return;
		console.log('User login', usr);
		pam.authenticate(usr, pwd, function(err) {
			if(err) {
				socket.emit('autherror', 'Login Failed');
			}
			else {
				console.log("Authenticated: ", usr);
				uid = uuid();
				on_user_login(socket,usr,uid);
			}
		});
	});

	socket.on("relog", function(uid) {
		console.log('User resume', uid);
		if ( !uid.match(/^[a-zA-Z0-9\-]+$/) ) {
			console.log('Invalid UUID used for relog!', uid);
			socket.close();
		}
			sessDb.get("SELECT user FROM sessions WHERE key=?", uid, function(err, row) {
				if ( !row ) return;
				console.log("Resuming session for: "+row.user);
				userid = row.user;
				on_user_login(socket, row.user, uid);
  		}).wait(function() {
				if ( !userid ) socket.emit('autherror', 'Failed to resume session');
			});

	});


	return;
	/*
	socket.on("resize", function(data){
		if ( !term ) return; //not yet open?
		term.resize(data.cols, data.rows);
	});

	socket.on("data", function(data){
		if ( !term ) return; //not yet open?
		term.write(data);
	});

	socket.on("bash", function(data){
		if ( term ) return; //already open?!
		term =  pty.spawn('bash', [], {
							name: 'xterm-color',
							cols: 80,
							rows: 30,
							cwd: process.env.HOME,
							env: process.env
						});
		term.on('data', function(data) {
			socket.emit("data", data);
		});
 });

 socket.on("screen", function(data){
   socket.type = "screen";
   ss = socket;
   console.log("Screen ready...");
 });
 socket.on("remote", function(data){
   socket.type = "remote";
   console.log("Remote ready...");
 });

 socket.on("controll", function(data){
	console.log(data);
   if(socket.type === "remote"){

     if(data.action === "tap"){
         if(ss != undefined){
            ss.emit("controlling", {action:"enter"});
            }
     }
     else if(data.action === "swipeLeft"){
      if(ss != undefined){
          ss.emit("controlling", {action:"goLeft"});
          }
     }
     else if(data.action === "swipeRight"){
       if(ss != undefined){
           ss.emit("controlling", {action:"goRight"});
           }
     }
   }
 });

 socket.on("video", function(data){

    if( data.action === "play"){
    var id = data.video_id,
         url = "http://www.youtube.com/watch?v="+id;

    var runShell = new run_shell('youtube-dl',['-o','%(id)s.%(ext)s','-f','/18/22',url],
        function (me, buffer) {
            me.stdout += buffer.toString();
            socket.emit("loading",{output: me.stdout});
            console.log(me.stdout);
         },
        function () {
            //child = spawn('omxplayer',[id+'.mp4']);
            omx.start(id+'.mp4');
        });
    }

 });*/
});
