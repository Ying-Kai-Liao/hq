//! The one-time usage analytics question (same copy as the phone and desktop apps).

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::text::Span;

use super::super::md::wrap;
use super::buffer::{centered, frame_box, put, put_line, u};
use super::style::theme;

const BODY: &str = "Codync can record which features you use on this computer, like creating a bot or \
sending a message. It never collects your messages, code, files, prompts or bot names. Your data stays \
private: it's used only to understand how people use Codync, never sold and never used for ads. When \
you're signed in, it's linked to your Codync account. Turn it off anytime: ^k → Share usage analytics.";

pub(super) fn consent(buf: &mut Buffer, area: Rect, share: bool) {
    let t = theme();
    let width: u16 = 66;
    let lines = wrap(&[Span::styled(BODY, t.text.patch(t.panel))], usize::from(width - 4), &[], &[]);
    let r = centered(area, width, u(lines.len() + 6));
    let inner = frame_box(buf, r, t.text, t.panel, Some(("Help improve Codync", t.text)));
    let mut y = inner.y;
    for l in &lines {
        put_line(buf, inner.x, y, inner.width, l);
        y += 1;
    }
    let style = |on: bool| if on { t.sel } else { t.text.patch(t.btn) }.add_modifier(Modifier::BOLD);
    let x = put(buf, inner.x, y + 1, 20, " y Share usage ", style(share)) + 1;
    let x = put(buf, x, y + 1, 20, " n Don't share ", style(!share)) + 2;
    put(buf, x, y + 1, inner.right().saturating_sub(x), "esc later", t.dim.patch(t.panel));
}
