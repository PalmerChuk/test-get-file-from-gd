/**
 * Usage :
 * 	node app3.js						- show google drive contents
 * 	node app3.js --find='Tolkien. The Lord of the ring'  - find file
 * 	node app3.js --get=id|filename		- download file from GD
 */


// app3.js - Add --get  file 
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


const CREDENTIALS_PATH  = 'AUTH-CREDENTIALS.json';	// Download from: https://developers.google.com/drive/api/v3/quickstart/nodejs
const TOKEN_PATH        = 'AUTH-TOKEN.json';

function fTime(msec, fmt='YYYY-MM-DD,HH:mm:ss') {
	return moment(msec).format(fmt);
}

function infoExpiryDate(token) {
	if (!token)                                     token = fs.readFileSync(TOKEN_PATH,'utf-8');
	if (Buffer.isBuffer(token))                     token = token.toString();
	if (typeof(token)==='string' && token[0]==='{') token = JSON.parse(token);
	return fTime(token.expiry_date,'YYYY-MM-DD,HH:mm:ss');
}


/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 * @param {google.auth.OAuth2} oAuth2Client The OAuth2 client to get token for.
 * @param {getEventsCallback} callback The callback for the authorized client.
 */
async function getAccessToken(oAuth2Client) {
	// If modifying these scopes, delete token.json.
	const SCOPES  = [
		'https://www.googleapis.com/auth/drive',			// <<-- ALL ACTIONS !!!
		'https://www.googleapis.com/auth/drive.activity',
		'https://www.googleapis.com/auth/drive.file',
		'https://www.googleapis.com/auth/drive.metadata'
		//  'https://www.googleapis.com/auth/drive.metadata.readonly'
	];
	const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });

	console.log('Authorize this app by visiting this url:', authUrl);

	exec(authUrl);  // CALL BROWSER like Chrom ...

	return new Promise((resolve,reject) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		rl.question('Enter the code from that page here: ', (code) => {
			rl.close();
			oAuth2Client.getToken(code, (err, token) => {
				if (err) {
					console.error('Error retrieving access token', err);
					reject(err);
				} else {
					fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
						if (err) {
							console.error('Can not save token', err);
							reject(err);
						} else {
							console.log('Token stored to', TOKEN_PATH, 'Note!!! It will expired at', infoExpiryDate(token));
							resolve(TOKEN_PATH);
						}
					});
				}
			});
		});
	});
}



/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 * @param {Object} credentials The authorization client credentials.
 * @param {function} callback The callback to call with the authorized client.
 */
async function authorize(credentials) {
    const { client_id, client_secret, redirect_uris } = credentials.installed;
    
	const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

	oAuth2Client.on('tokens', (tokens) => {
		if (tokens.refresh_token) { // store the refresh_token in my database!
			console.log('Token refresh:',tokens.refresh_token);
			fs.writeFileSync('token-refresh.json',JSON.stringify(tokens.refresh_token,null,4));
		}
		console.log('Token access :',tokens.access_token);
	});


	try {
		let stat = fs.statSync(TOKEN_PATH);
		if (!stat || !stat.isFile()) throw new Error('TOKEN-IS-ABSENT');
	} catch(err) {
		await getAccessToken(oAuth2Client);
	}

    let token = fs.readFileSync(TOKEN_PATH,'utf8');
    if (Buffer.isBuffer(token))   token = token.toString();
    if (typeof(token)==='string') token = JSON.parse(token);
    console.log('Token: setCredentials:',token);

    oAuth2Client.setCredentials(token);
	console.log('Token: will expired at',infoExpiryDate(token));

    return oAuth2Client;
}

function exec(url) {
	const chield_process = require('child_process');
	chield_process.execSync(`open '${url}'`,{});
}

const Folders = {};


function cmpFilesByDirNameTime(e1,e2) {
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





function listFiles(drive, options) {

	let Num = 0;
	let foldersOnly = options && /q.*mimeType.*vnd.google-apps.folder/.test(JSON.stringify(options));
	let folderOnly  = argv.oparent;

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
				console.error('The API returned an error: ' + err);
				return reject(err);
			} else {
				let files = res.data.files;
				// fs.writeFileSync('lastRes.json', JSON.stringify(res, null, 8)); // console.log('Res: ',JSON.stringify(res));
				if (files.length) {

					if (folderOnly && !foldersOnly) {
						// let folderId; _.each(Folders, (name, id) => { if (name === folderOnly) folderId = id; });
						// console.log('NAME => ID',folderOnly, folderId)
						//if (folderId) files = _.filter(files, file => file && file.parents && file.parents.includes(folderId));
						files = _.filter(files, file => file && file.parents && file.parents.includes(folderOnly));
					}

					files = files.sort(cmpFilesByDirNameTime);

					files.map(file => {
						if (foldersOnly) Folders[file.id] = file.name;
						if (foldersOnly && folderOnly) return null; // Skip first scan for regime "OnlyOneDir"

						const line = sprintf('%4s %-28s %10s %-20s %-40s %s'
							, (++Num)
							, slot(file.id, 28)
							, file.size || '-'
							, file.createdTime || file.modifiedTime ? fTime(file.createdTime || file.modifiedTime) : '-'
							, slot(file.name, 40)
							, mayBeFolder(file.parents)
						);
						console.log(line); // , file.mimeType);
					});

					if (res.data.nextPageToken) {
						// console.log('Next Page...');
						return drive.files.list(_.extend(fetchParams, {pageToken: res.data.nextPageToken}), printBit);
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
		.then(async () => {
			// Make list of folders ...
			await listFiles(drive,{ orderBy: "name", q: "mimeType='application/vnd.google-apps.folder'"});
			if (!argv.oparent)
				console.log('==== === end of folders === ===== ==============================');
			else {
				let folderName = argv.oparent;
				let folderId   = _.chain(Folders).toPairs().filter(([id,name]) => name===folderName).map(p => p[0]).value();
				argv.oparent = folderId ? folderId[0] : null; // Redefine with ID !!!  null - not found ?!
				console.log('Oparent', folderName, '=>', folderId);
			}
		})
		.then(() => {
		    return listFiles(drive,{ orderBy: "folder" });
		})
		.catch(err => {
		    console.warn('Error occured during driveList() :',err.message || err);
		    return Promise.reject(err);
		});
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
        //  let down = await drive.files.export({ fileId: id, mimeType:'fb2' }); // -- only for Google Docs ?!
            let down = drive.files.get({ fileId: id, alt:'media' });
            console.log('Down=',down);

            if (_.isObject(down) && _.isFunction(down.then))
            	return down
					.then((Rc) => {
						if (Rc.data) {
							console.warn('WRITE FILE with data %s ...',_.size(Rc.data));
							fs.writeFileSync(oname,Rc.data);
							Rc.data = `[${_.size(Rc.data)}]`;
						}
						console.log('Down resolved',Rc);
					})
					.catch(err => console.error('Down failed:',err))
					;

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
	
	let credentials;
	
	try {
	    credentials = fs.readFileSync(CREDENTIALS_PATH,'utf8');     // Load client secrets from a local file.
	} catch(err) {
	    if (/not.*found|no.*such/i.test(err)) {
		console.log(`Sorry! I guess you forgot: 
		you must first download credentials from "https://console.developers.google.com/apis/credentials"
		then - save it as file "${CREDENTIALS_PATH}"
		`);
		return Promise.reject('Credentials not found');
	    }
	    throw err;
	}
        
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
