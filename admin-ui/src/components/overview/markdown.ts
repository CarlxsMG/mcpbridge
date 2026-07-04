// Deliberately tiny, safe Markdown → HTML for the Note widget.
//
// Security: ALL input is HTML-escaped FIRST, so no user-supplied tag or
// attribute can survive — the only tags in the output are the ones this
// function emits. Links are autolinked from `http(s)://…` only (never a
// `[text](url)` syntax), so a `javascript:`/`data:` scheme can never become an
// href. This is what lets NoteWidget render the result without exposing an XSS
// vector; do not "upgrade" this to a general Markdown lib without re-checking
// that guarantee (see markdown.test.ts).

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Operates on already-escaped text, so the only literal characters it keys off
// (`* _ ` [ h t t p`) are safe markers, never markup.
function inline(escaped: string): string {
  let out = escaped;
  // inline code first, so emphasis markers inside it are left literal
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  // autolink http(s) URLs (escaped, so any & is already &amp;)
  out = out.replace(
    /(https?:\/\/[^\s<]+)/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return out;
}

export function renderMarkdown(src: string): string {
  const lines = escapeHtml(src ?? "").split(/\r?\n/);
  const html: string[] = [];
  let listOpen = false;

  const closeList = () => {
    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);

    if (heading) {
      closeList();
      const level = heading[1].length + 2; // # -> h3, ## -> h4, ### -> h5
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (bullet) {
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${inline(bullet[1])}</li>`);
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      html.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return html.join("\n");
}
