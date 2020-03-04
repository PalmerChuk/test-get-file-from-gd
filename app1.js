
// Add order: directories, then files ...

const {google} = require('googleapis');

const fs       = require('fs');
const readline = require('readline');
const moment   = require('moment');
const sprintf  = require('sprintf-js').sprintf;
const _        = require('lodash');

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/drive.metadata.readonly'];
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

	// Check if we have previously stored a token.
	fs.readFile(TOKEN_PATH, (err, token) => {
		if (err) {
			console.error('Error read token:',err.message);
			return getAccessToken(oAuth2Client, callback);
		} else {
			oAuth2Client.setCredentials(JSON.parse(token));
			callback(oAuth2Client);
			//---------------------------------------------------------
			console.log('Token will expired at',infoExpiryDate(token));
		}
	});
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
	const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
	console.log('Authorize this app by visiting this url:', authUrl);
	exec(authUrl);
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


async function listDrive(drive) {
	return Promise.resolve()
		.then(() => listFiles(drive,{ orderBy: "name", q: "mimeType='application/vnd.google-apps.folder'"}))
		.then(() => console.log('==== === end of folders === ===== ==============================') )
		.then(() => listFiles(drive,{ orderBy: "folder" }))
		;
}

//==================================================
//==================================================
//==================================================

// Load client secrets from a local file.
let credentials = fs.readFileSync(CREDENTIALS_PATH,'utf8');

// Authorize a client with credentials, then call the Google Drive API.
credentials = JSON.parse(credentials);

return Promise.resolve()
	.then(() => {
		return new Promise((resolve,reject) => {
			authorize(credentials, (auth) => {
				const drive = google.drive({version: 'v3', auth});
				return listDrive(drive).then(rc => resolve(rc)).catch(err => reject(err));
			});
		});
	})
	.then((Rc) => {
		console.log('Bye.',Rc);
		process.exit(0);
	})
	.catch(err => {
		console.log('Something wrong ?- ',err);
		process.exit(1);
	});
