// @ts-check

const DEPTH_MAX = 16;
const SAVED_HTML_MARK = "\u0000";
const SAVED = /\u0000(\d+)\u0000/g;

/** A backtick fence's info has no backtick, so ```x``` on one line is a code span. */
const FENCE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})[ \t]*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const RULE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const TASK = /^\[([ xX])\][ \t]+/;
const LINK =
	/(!?)\[([^[\]\n]{0,1000})\]\([ \t]*<?([^\s<>()\u0000]{0,2048})>?(?:[ \t]+(?:"[^"\n]{0,500}"|'[^'\n]{0,500}'))?[ \t]*\)/g;
const BARE_URL = /\bhttps?:\/\/[^\s<>"'`\u0000]+/gi;
const ESCAPED = /\\([!-/:-@[-`{-~])/g;

/** @param {unknown} text */
function esc(text) {
	return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** @param {string} text @returns {string} */
export function markdown(text) {
	const lines = String(text)
		.replaceAll(SAVED_HTML_MARK, "")
		.split(/\r?\n/)
		.map((line) => line.replace(/^[ \t]+/, (indent) => indent.replaceAll("\t", "    ")));
	return blocks(lines, 0, false);
}

/** @param {string} line */
function indentOf(line) {
	return line.length - line.trimStart().length;
}

/** @param {string[]} lines @param {number} depth @param {boolean} tight */
function blocks(lines, depth, tight) {
	let html = "";
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim()) {
			i++;
			continue;
		}
		const fence = FENCE.exec(line);
		if (fence) {
			const indent = indentOf(line);
			const body = [];
			for (i++; i < lines.length && !closes(lines[i], fence[1]); i++) {
				body.push(lines[i].slice(Math.min(indent, indentOf(lines[i]))));
			}
			i++;
			const lang = fence[2].slice(0, 32);
			html += `<div class="code">${lang ? `<div class="lang">${esc(lang)}</div>` : ""}<pre><code>${esc(body.join("\n"))}</code></pre></div>`;
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			const level = heading[1].length;
			html += `<h${level}>${inline((heading[2] ?? "").replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trim())}</h${level}>`;
			i++;
			continue;
		}
		if (RULE.test(line)) {
			html += "<hr>";
			i++;
			continue;
		}
		if (depth < DEPTH_MAX && QUOTE.test(line)) {
			const inner = [];
			for (let quote = QUOTE.exec(lines[i]); quote; quote = i < lines.length ? QUOTE.exec(lines[i]) : null) {
				inner.push(quote[1]);
				i++;
			}
			html += `<blockquote>${blocks(inner, depth + 1, false)}</blockquote>`;
			continue;
		}
		if (depth < DEPTH_MAX && ITEM.test(line)) {
			const list = listAt(lines, i, depth);
			html += list.html;
			i = list.end;
			continue;
		}
		const header = i + 1 < lines.length ? tableHeader(line, lines[i + 1]) : undefined;
		if (header) {
			const rows = [];
			for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes("|"); i++) rows.push(cells(lines[i]));
			html += tableHtml(header.names, header.align, rows);
			continue;
		}
		const paragraph = [line.trim()];
		for (i++; i < lines.length && lines[i].trim() && !startsBlock(lines, i, depth); i++) {
			paragraph.push(lines[i].trim());
		}
		const content = inline(paragraph.join("\n"));
		html += tight ? content : `<p>${content}</p>`;
	}
	return html;
}

/** @param {string} line @param {string} fence */
function closes(line, fence) {
	const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
	return match !== null && match[1][0] === fence[0] && match[1].length >= fence.length;
}

/** @param {string[]} lines @param {number} i @param {number} depth */
function startsBlock(lines, i, depth) {
	const line = lines[i];
	return (
		FENCE.test(line) ||
		HEADING.test(line) ||
		RULE.test(line) ||
		(depth < DEPTH_MAX && (QUOTE.test(line) || ITEM.test(line))) ||
		(i + 1 < lines.length && tableHeader(line, lines[i + 1]) !== undefined)
	);
}

/** @param {string[]} lines @param {number} start @param {number} depth */
function listAt(lines, start, depth) {
	const first = /** @type {RegExpExecArray} */ (ITEM.exec(lines[start]));
	const ordered = /\d/.test(first[2]);
	/** @param {string} line */
	const sibling = (line) => {
		const item = ITEM.exec(line);
		return item !== null && /\d/.test(item[2]) === ordered && !RULE.test(line);
	};
	/** @type {string[][]} */
	const items = [];
	let loose = false;
	let i = start;
	while (i < lines.length && sibling(lines[i])) {
		const item = /** @type {RegExpExecArray} */ (ITEM.exec(lines[i]));
		const gap = item[3] ?? "";
		const width = item[1].length + item[2].length + (gap.length > 4 || !item[4] ? 1 : gap.length);
		const body = [item[4] ?? ""];
		let blank = false;
		for (i++; i < lines.length; i++) {
			const line = lines[i];
			if (!line.trim()) {
				blank = true;
				continue;
			}
			if (indentOf(line) >= width) {
				if (blank) {
					body.push("");
					loose = true;
				}
				body.push(line.slice(width));
				blank = false;
				continue;
			}
			if (!blank && !startsBlock(lines, i, depth)) {
				body.push(line.trim());
				continue;
			}
			break;
		}
		items.push(body);
		if (blank && i < lines.length && sibling(lines[i])) loose = true;
		else if (blank) break;
	}
	const number = Number.parseInt(first[2], 10);
	const open = ordered ? (number === 1 ? "<ol>" : `<ol start="${number}">`) : "<ul>";
	const html = items.map((body) => itemHtml(body, depth, loose)).join("");
	return { html: `${open}${html}${ordered ? "</ol>" : "</ul>"}`, end: i };
}

/** @param {string[]} body @param {number} depth @param {boolean} loose */
function itemHtml(body, depth, loose) {
	const task = TASK.exec(body[0]);
	if (task) body[0] = body[0].slice(task[0].length);
	const content = blocks(body, depth + 1, !loose);
	if (!task) return `<li>${content}</li>`;
	return `<li class="task"><input type="checkbox" disabled${task[1] === " " ? "" : " checked"}> ${content}</li>`;
}

/** @param {string} line */
function cells(line) {
	const row = line.trim();
	/** @type {string[]} */
	const out = [];
	let cell = "";
	for (let i = 0; i < row.length; i++) {
		const c = row[i];
		if (c === "\\" && row[i + 1] === "|") {
			cell += row[++i];
		} else if (c === "\\" && i + 1 < row.length) {
			cell += c + row[++i];
		} else if (c === "|") {
			out.push(cell);
			cell = "";
		} else cell += c;
	}
	out.push(cell);
	if (row.startsWith("|")) out.shift();
	if (out.length > 1 && /(?:^|[^\\])\|$/.test(row)) out.pop();
	return out.map((c) => c.trim());
}

/** @param {string} line @param {string} next */
function tableHeader(line, next) {
	if (!line.includes("|") || !next.includes("|") || !/^[ \t|:-]+$/.test(next)) return undefined;
	const names = cells(line);
	const delimiters = cells(next);
	if (names.length !== delimiters.length || !delimiters.every((d) => /^:?-+:?$/.test(d))) return undefined;
	const align = delimiters.map((d) => (d.endsWith(":") ? (d.startsWith(":") ? "c" : "r") : "l"));
	return { names, align };
}

/** @param {string[]} names @param {string[]} align @param {string[][]} rows */
function tableHtml(names, align, rows) {
	/** @param {string} tag @param {string[]} row */
	const rowHtml = (tag, row) =>
		`<tr>${align.map((a, i) => `<${tag} class="${a}">${inline(row[i] ?? "")}</${tag}>`).join("")}</tr>`;
	const body = rows.length ? `<tbody>${rows.map((row) => rowHtml("td", row)).join("")}</tbody>` : "";
	return `<div class="table"><table><thead>${rowHtml("th", names)}</thead>${body}</table></div>`;
}

/** @param {string} text */
function inline(text) {
	/** @type {string[]} */
	const saved = [];
	/** @param {string} html */
	const keep = (html) => `${SAVED_HTML_MARK}${saved.push(html) - 1}${SAVED_HTML_MARK}`;
	let s = codeSpans(text, keep);
	s = s.replace(ESCAPED, (_, c) => keep(esc(c)));
	s = s.replace(LINK, (_, bang, label, url) => {
		const content = emphasis(esc(label)) || (bang ? "image" : "");
		return keep(/^https?:\/\/./i.test(url) ? linkHtml(url, content || esc(url)) : content);
	});
	s = s.replace(BARE_URL, (url) => {
		const link = trimUrl(url);
		return keep(linkHtml(link, esc(link))) + url.slice(link.length);
	});
	const html = emphasis(esc(s)).replaceAll("\n", "<br>");
	/** @param {string} h @returns {string} */
	const restore = (h) => h.replace(SAVED, (_, n) => restore(saved[Number(n)]));
	return restore(html);
}

/** @param {string} url @param {string} content */
function linkHtml(url, content) {
	return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${content}</a>`;
}

/** @param {string} url */
function trimUrl(url) {
	let opens = 0;
	let closes = 0;
	for (const c of url) {
		if (c === "(") opens++;
		else if (c === ")") closes++;
	}
	let end = url.length;
	while (end > 0) {
		const c = url[end - 1];
		if (".,;:!?*_~".includes(c)) end--;
		else if (c === ")" && closes > opens) {
			end--;
			closes--;
		} else break;
	}
	return url.slice(0, end);
}

/** @param {string} text @param {(html: string) => string} keep */
function codeSpans(text, keep) {
	if (!text.includes("`")) return text;
	const runs = [...text.matchAll(/`+/g)].map((m) => ({ at: m.index ?? 0, size: m[0].length }));
	/** @type {number[]} */
	const partner = [];
	/** @type {Map<number, number>} */
	const nextOfSize = new Map();
	for (let k = runs.length - 1; k >= 0; k--) {
		partner[k] = nextOfSize.get(runs[k].size) ?? -1;
		nextOfSize.set(runs[k].size, k);
	}
	let out = "";
	let from = 0;
	for (let k = 0; k < runs.length; k++) {
		const close = partner[k];
		if (close < 0) continue;
		const open = runs[k];
		let code = text.slice(open.at + open.size, runs[close].at).replaceAll("\n", " ");
		if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
		out += text.slice(from, open.at) + keep(`<code>${esc(code)}</code>`);
		from = runs[close].at + runs[close].size;
		k = close;
	}
	return out + text.slice(from);
}

/** @param {string} html @returns {string} */
function emphasis(html) {
	const em = (/** @type {string} */ s) =>
		pairs(s, "*", "<em>", "</em>", false, (t) => pairs(t, "_", "<em>", "</em>", true));
	const strong = (/** @type {string} */ s) =>
		pairs(s, "**", "<strong>", "</strong>", false, (t) => pairs(t, "__", "<strong>", "</strong>", true, em));
	const both = (/** @type {string} */ s) => pairs(s, "***", "<strong><em>", "</em></strong>", false, strong);
	return pairs(html, "~~", "<del>", "</del>", false, both);
}

/** @param {string} text @param {string} delimiter @param {string} open @param {string} close @param {boolean} wordy @param {(text: string) => string} [inner] @returns {string} */
function pairs(text, delimiter, open, close, wordy, inner = (t) => t) {
	if (!text.includes(delimiter)) return inner(text);
	const parts = text.split(delimiter);
	let out = inner(parts[0]);
	let k = 1;
	while (k < parts.length) {
		const content = parts[k];
		const closed = k + 1 < parts.length;
		const flanked = content !== "" && !/^\s/.test(content) && !/\s$/.test(content);
		const word = wordy && (/\w$/.test(parts[k - 1]) || (closed && /^\w/.test(parts[k + 1])));
		if (closed && flanked && !word) {
			out += `${open}${inner(content)}${close}${inner(parts[k + 1])}`;
			k += 2;
		} else {
			out += delimiter + inner(content);
			k++;
		}
	}
	return out;
}
