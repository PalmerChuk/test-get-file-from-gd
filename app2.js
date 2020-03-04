
// app2.js - Add --find file
// app1.js - Add order: directories, then files ...

const {google} = require('googleapis');

const fs       = require('fs');
const readline = require('readline');
const moment   = require('moment');
const sprintf  = require('sprintf-js').sprintf;
const _        = require('lodash');
const Q        = require('q');
const argv     = require('optimist').argv;


// The file token.json stores the user's access and refresh tokens,
// and is created automatically when the authorization flow completes for the first time.
const TOKEN_PATH        = 'TOKEN-REWRITABLE.json';
const CREDENTIALS_PATH  = 'CREDENTIALS-FROM-GOOGLE-OAUTH2.json';

function fTime(msec, fmt='YYYY-MM-DD,HH:mm:ss') {
	return moment(msec).format(fmt);
}

function infoExpiryDate(token) {
	if (!token)                                     token = fs.readFileSync(TOKEN_PATH,'utf-8');
	if (Buffer.isBuffer(token))                     token = token.toString();
	if (typeof(token)==='string' && token[0]==='{') token = JSON.parse(token);
	return fTime(token.expiry_date,'YYYY-MM-DD,HH:mm:ss'); //return moment.utc(token.expiry_date).format('YYYY-MM-DD,HH:mm:ss');
}

/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 * @param {Object} credentials The authorization client credentials.
 * @param {function} callback The callback to call with the authorized client.
 */
function authorize(credentials, callback) {
    const { client_secret, client_id, redirect_uris } = credentials.installed;
    
	const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

	oAuth2Client.on('tokens', (tokens) => {
		if (tokens.refresh_token) {
			// store the refresh_token in my database!
			console.log('Refresh tokens:',tokens.refresh_token);
			fs.writeFileSync('token-refresh.json',JSON.stringify(tokens.refresh_token,null,4));
		}
		console.log('Access tokens:',tokens.access_token);
	});

    let defer = null;
    if (!callback) defer = Q.defer();

	// Check if we have previously stored a token.
	fs.readFile(TOKEN_PATH, (err, token) => {
		if (err) {
            console.error('Error read token:',err.message,'Trying to get new! ...');
            // TODO: doesn't work with defer :-()
            if (!callback) return getAccessToken(oAuth2Client, (auth) => defer.resolve(auth));
			else           return getAccessToken(oAuth2Client, callback);
		} else {
            //if (Buffer.isBuffer(token))   token = token.toString();
            //if (typeof(token)==='string') token = JSON.parse(token);
            // if (argv.get) token.scope = 'https://www.googleapis.com/auth/drive.activity';
            console.log('Set credentials:',token);
            oAuth2Client.setCredentials(JSON.parse(token));
            if (defer) defer.resolve(oAuth2Client);
			else       callback(oAuth2Client);
			//---------------------------------------------------------
			console.log('Token will expired at',infoExpiryDate(token));
		}
    });
    
    return defer && defer.promise;
}

function exec(url) {
	const chield_process = require('child_process');
	chield_process.execSync(`open '${url}'`,{});
}


/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 * @param {google.auth.OAuth2} oAuth2Client The OAuth2 client to get token for.
 * @param {getEventsCallback} callback The callback for the authorized client.
 */
async function getAccessToken(oAuth2Client, callback) {
    // If modifying these scopes, delete token.json.
    const SCOPES  = [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive.metadata',
		'https://www.googleapis.com/auth/drive.activity'
    //  'https://www.googleapis.com/auth/drive.metadata.readonly'
    ];
	const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
    
    console.log('Authorize this app by visiting this url:', authUrl);
    
    exec(authUrl);  // CALL BROWSER like Chrom ...
    
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	rl.question('Enter the code from that page here: ', (code) => {
		rl.close();
		oAuth2Client.getToken(code, (err, token) => {
			if (err) return console.error('Error retrieving access token', err);
			oAuth2Client.setCredentials(token);
			// Store the token to disk for later program executions.
			fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
				if (err) return console.error(err);
				console.log('Token stored to', TOKEN_PATH, 'Note!!! It will expired at',infoExpiryDate(token));
			});
			callback(oAuth2Client);
		});
	});
}


const Folders = {};


function listFiles(drive, options) {

	let Num = 0, folderOnly = options && /q.*mimeType.*vnd.google-apps.folder/.test(JSON.stringify(options));

	const fetchParams = {
		pageSize: 256,
		fields: 'nextPageToken, files(id,name,size,kind,createdTime,modifiedTime,parents,mimeType)'
	};

	if (options) {
		if (options.q)       fetchParams.q       = options.q; 		// query
		if (options.orderBy) fetchParams.orderBy = options.orderBy; // sort
	}

	function slot(s,len) { return String(s).length>len ? (String(s).substr(0,len-2)+'>#') : s; }
	function mayBeFolder(gid) {
		if (gid && Array.isArray(gid)) { // ... [ '0B9xEM5hxyXRrRk1UOW5wMFpRdE0' ] file.mimeType=application/pdf
			const fid = gid[0];
			return Folders[fid] || fid;
		} else {
			return gid;
		}
	}

	return new Promise((resolve,reject) => {

		function printBit(err, res) {

			if (err) {
				console.log('The API returned an error: ' + err);
				return reject(err);
			} else {
				let files = res.data.files;
				// fs.writeFileSync('lastRes.json', JSON.stringify(res, null, 8)); // console.log('Res: ',JSON.stringify(res));
				if (files.length) {


					function cmpByDir(e1,e2) {
						let dif=0;
						if (!dif) {
							let folder1 = String(e1 && e1.parents && e1.parents[0]);
							let folder2 = String(e2 && e2.parents && e2.parents[0]);
							dif = folder1.localeCompare(folder2);
						}
						if (!dif) {
							let name1 = String(e1 && e1.name);
							let name2 = String(e2 && e2.name);
							dif = name1.localeCompare(name2);
						}
						if (!dif) {
							let mtime1 = moment((e1 && (e1.createdTime || e1.modifiedTime)) || '2000-01-01 09:00:00');
							let mtime2 = moment((e2 && (e2.createdTime || e2.modifiedTime)) || '2000-01-01 09:00:00');
							dif = mtime1.isBefore(mtime2) ? -1 : mtime1.isAfter(mtime2) ? 1 : 0;
						}
						return dif;
					}

					files = res.data.files.sort(cmpByDir);

					files.map(file => {
						const line = sprintf('%4s %-28s %10s %-20s %-40s %s'
							, (++Num)
							, slot(file.id, 28)
							, file.size || '-'
							, file.createdTime || file.modifiedTime ? fTime(file.createdTime || file.modifiedTime) : '-'
							, slot(file.name, 40)
							, mayBeFolder(file.parents)
						);
						console.log(line); // , file.mimeType);
						if (folderOnly) Folders[file.id] = file.name;
					});

					if (res.data.nextPageToken) { // files.nextPageToken) {
						// console.log('Next Page...');
						return drive.files.list(_.extend(fetchParams, {pageToken: res.data.nextPageToken}), printBit); // pageSize:10,
					} else {
						resolve(Num);
					}
				} else {
					console.log('No files found.');
					resolve(0);
				}
				return Num;
			}
		}

		return drive.files.list(fetchParams, printBit);
	});
}

async function driveList(drive) {
	return Promise.resolve()
		.then(() => listFiles(drive,{ orderBy: "name", q: "mimeType='application/vnd.google-apps.folder'"}))
		.then(() => console.log('==== === end of folders === ===== ==============================') )
		.then(() => listFiles(drive,{ orderBy: "folder" }))
		;
}

function driveFind(drive, fileId, options) {

    const fetchParams = {
        pageSize: 512,
        fields: 'nextPageToken, files(id,name,size,kind,createdTime,modifiedTime,parents,mimeType)'
    };
    
    if (options) {
        if (options.fields) fetchParams.fields = `nextPageToken, files(${options.fields})`
    }

    let Found = {};
    let Num   = 0;

    return new Promise((resolve,reject) => {
    
        function processBatch(err, res) {
            if (err) {
                console.log('The API returned an error: ' + err);
                return reject(err);
            } else {
                let files = res.data.files;
                if (files.length) {
                    files.map(file => {
                        if (file.name===fileId || file.id===fileId) { Found[file.id] = file; Num+=1; }
                    });
                }        
                if (res.data.nextPageToken) {
                    return drive.files.list(_.extend(fetchParams, {pageToken: res.data.nextPageToken}), processBatch);
                } else {
                    return resolve(Found);
                }
            }
        }
        
        return drive.files.list(fetchParams, processBatch);
    });
}

async function driveDown(drive,list,options) {
    return new Promise(async (resolve,reject) => {
        let oname = ( options && options.oname ) || 'downloaded.tmp';
        oname = './' + oname;

        let id = _.keys(list)[0];
        let file = list[id];

        const dest = fs.createWriteStream(oname);
        console.log('Try get "%s" "%s" as "%s" ...',id,file.name,oname);
        try {
        //  let down = await drive.files.export({ fileId: id, mimeType:'fb2' });
            let down = drive.files.get({ fileId: id, alt:'media' });
            console.log('Down=',down);
            //if (_.isPromise(down)) return down.then((Rc) => console.log('Down resolved',Rc));
            if (_.isObject(down) && _.isFunction(down.then))
            	return down
					.then((Rc) => console.log('Down resolved',Rc))
					.catch(err => console.error('Down failed:',err))
					;

            if (down && _.isFunction(down.on))
            	return down
					.on('end'  ,() => { console.log('Done:',file.name,'=>',oname); resolve(oname); })
					.on('error',() => { console.error('Error download:',err,id,file); reject(err); })
					.pipe(dest);

            return down;
        } catch(err) {
            console.error('Catch error "%s" :-(',err.message || err);
            reject(err);
        }
        /*
        _.each(list, async (file,id) => {
            const dest = fs.createWriteStream(oname);
            console.log('Try get',id,file.name,'as',oname,'...');
        //  let down = await drive.files.get({ fileId: id, alt:'media'});
            let down = await drive.files.export({ fileId: id });
            console.log('Down=',down);
            return down
                //.on('end'  ,() => { console.log('Done:',file.name,'=>',oname); resolve(oname); })
                //.on('error',() => { console.error('Error download:',err,id,file); reject(err); })
                //.pipe(dest)
                ;
        });
        */
    }).then((Rc) => {
        console.log('===DownOk:',Rc);
        return Rc;
    })
    .catch(err => {
        console.error('===Down: FIG VAM!',err.message,err);
        throw err;        
    });
}

//==================================================
//==================================================
//==================================================

return Promise.resolve()
	.then(async () => {
        
        let credentials = fs.readFileSync(CREDENTIALS_PATH,'utf8');     // Load client secrets from a local file.
        credentials = JSON.parse(credentials);                          // Authorize a client with credentials, then call the Google Drive API.
		const auth  = await authorize(credentials);
        const drive = google.drive({version: 'v3', auth});

        if (argv.find)     return driveFind(drive,argv.find,{fields:argv.fields});
        else if (argv.get) return driveFind(drive,argv.get ,{fields:null})
                                    .then(found => driveDown(drive,found,{oname:argv.oname}));
        else               return driveList(drive);
	})
	.then((Rc) => {
		console.log('Bye.',Rc);
		process.exit(0);
	})
	.catch(err => {
		console.log('Something wrong ?- ',err);
		process.exit(1);
	});
