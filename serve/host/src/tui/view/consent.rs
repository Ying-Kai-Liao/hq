//! The one-time usage analytics question (same copy as the phone and desktop apps).

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::text::{Line, Span};

use super::super::md::wrap;
use super::buffer::{centered, frame_box, put, put_line, u};
use super::style::theme;

const LEAD: &str =
    "Codync can record which features you use on this computer, like creating a bot or sending a message.";
const POINTS: [&str; 3] = [
    "Never your messages, code, files, prompts or bot names.",
    "Never sold or used for ads. Linked to your Codync account when you're signed in.",
    "Turn it off anytime: ^k → Share usage analytics.",
];

pub(super) fn consent(buf: &mut Buffer, area: Rect, share: bool) {
    let t = theme();
    let width: u16 = 66;
    let text = t.text.patch(t.panel);
    let w = usize::from(width - 4);
    let mut lines = wrap(&[Span::styled(LEAD, text)], w, &[], &[]);
    lines.push(Line::default());
    for point in POINTS {
        lines.extend(wrap(&[Span::styled("· ", t.dim.patch(t.panel)), Span::styled(point, text)], w, &[], &[]));
    }
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
