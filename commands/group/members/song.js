import fs from "fs";
import yts from "yt-search";
import ffmpeg from "ffmpeg-static";
import defaultYoutubedl, { create } from "youtube-dl-exec";
import memoryManager from "../../../utils/memory.js";
import { readFileEfficiently, isValidAudioFile } from "../../../utils/file.js";

const getRandom = (ext) => memoryManager.generateTempFileName(ext);

// Use the system yt-dlp binary when YTDLP_PATH is set (e.g. /usr/local/bin/yt-dlp on
// the server). Otherwise fall back to the binary bundled with youtube-dl-exec.
const youtubedl = process.env.YTDLP_PATH ? create(process.env.YTDLP_PATH) : defaultYoutubedl;

import { getCookiePath } from "../../../functions/cookieManager.js";

const ytdlpOpts = async (extra = {}) => {
	const opts = {
		noCheckCertificates: true,
		noWarnings: true,
		noPlaylist: true,
		forceIpv4: true,
		ffmpegLocation: ffmpeg,
		// tv + android_vr work without a PO token (server-side, no browser). web is
		// kept last as a cookie-backed extra. android/ios are dead on modern YouTube.
		extractorArgs: "youtube:player_client=tv,android_vr,web",
		// yt-dlp now requires an EJS runtime to solve YouTube JS challenges (2026+).
		// Node.js is available in the container, so use it.
		jsRuntimes: "node",
		...extra,
	};
	const cookiePath = await getCookiePath();
	if (cookiePath) opts.cookies = cookiePath;
	return opts;
};

const findSongURL = async (name) => {
	const r = await yts(`${name}`);
	if (!r.all || r.all.length === 0) throw new Error("No results found");
	return r.all[0].url;
};

const handler = async (sock, msg, from, args, msgInfoObj) => {
	const { evv, command, sendMessageWTyping } = msgInfoObj;

	if (!args[0]) return sendMessageWTyping(from, { text: `❌ *Enter song name*` }, { quoted: msg });

	await sendMessageWTyping(from, { text: `🔍 Searching for: *${evv}*...` }, { quoted: msg });
	console.log("Song request:", evv);

	const fileDown = getRandom(".mp3");
	let title = "Unknown Song";

	try {
		let URL;
		try {
			URL = await findSongURL(evv);
			console.log("Found URL:", URL);
		} catch (searchError) {
			console.error("Search failed:", searchError);
			return sendMessageWTyping(from, { text: `❌ No songs found for: *${evv}*` }, { quoted: msg });
		}

		await sendMessageWTyping(from, { text: `⏳ Downloading audio...` }, { quoted: msg });

		// Title (best-effort)
		try {
			const info = await youtubedl(URL, await ytdlpOpts({ dumpSingleJson: true }));
			title = info.title || "Unknown Song";
		} catch (e) {
			console.log("Title fetch failed:", e.message);
		}

		// Download + extract to mp3 (yt-dlp uses ffmpeg-static)
		await youtubedl(
			URL,
			await ytdlpOpts({
				format: "bestaudio/best",
				extractAudio: true,
				audioFormat: "mp3",
				audioQuality: 0,
				output: fileDown,
			})
		);

		if (!fs.existsSync(fileDown)) throw new Error("Audio file was not created");
		if (!isValidAudioFile(fileDown)) throw new Error("Invalid audio file generated");

		const stats = await fs.promises.stat(fileDown);
		const fileSizeMB = stats.size / 1024 / 1024;
		if (stats.size === 0) throw new Error("Downloaded file is empty");
		if (fileSizeMB > 50) throw new Error(`File too large: ${fileSizeMB.toFixed(2)}MB (max 50MB)`);

		console.log(`Audio ready: ${fileSizeMB.toFixed(2)}MB - ${title}`);

		const audioBuffer = await readFileEfficiently(fileDown);
		let sock_data;
		if (command === "song") {
			sock_data = {
				document: audioBuffer,
				mimetype: "audio/mpeg",
				fileName: `${title}.mp3`,
				ptt: true,
				caption: `🎵 *${title}*\n📊 Size: ${fileSizeMB.toFixed(2)}MB`,
			};
		} else {
			sock_data = {
				audio: audioBuffer,
				mimetype: "audio/mpeg",
				fileName: `${title}.mp3`,
			};
		}

		await sendMessageWTyping(from, sock_data, { quoted: msg });
		console.log("Audio sent successfully");
	} catch (err) {
		console.error("Song download error:", err);
		const m = (err.message || "").toLowerCase();
		let errorMsg = "❌ Download failed. ";
		if (m.includes("sign in to confirm") || m.includes("bot")) {
			errorMsg += "YouTube is blocking this server. Set YTDLP_COOKIES to fix.";
		} else if (m.includes("age")) {
			errorMsg += "Age-restricted. Set YTDLP_COOKIES to download.";
		} else if (m.includes("too large")) {
			errorMsg += err.message;
		} else {
			errorMsg += "Please try again with a different song.";
		}
		await sendMessageWTyping(from, { text: errorMsg }, { quoted: msg });
	} finally {
		memoryManager.safeUnlink(fileDown);
	}
};

export default () => ({
	cmd: ["song", "play"],
	desc: "Download song",
	usage: "song | play | song [song name]",
	handler,
});
