#![allow(non_snake_case)]

pub(crate) mod controls;
mod control_font;
mod dialog;
mod dialog_template;
mod dialog_helpers;
mod updown;
pub use dialog_helpers::*;
mod menu;
mod message;
mod misc;
mod paint;
mod rect;
mod raw_input;
pub use raw_input::*;
mod resource;
mod timer;
mod window;

use super::handle::Handles;
use super::types::HWND;

pub use super::gdi32::HDC;
pub use super::kernel32::ResourceKey;
pub use dialog::*;
pub use menu::*;
pub use message::*;
pub use misc::*;
pub use paint::*;
pub use rect::*;
pub use resource::*;
pub use timer::*;
pub use window::*;

#[derive(Default)]
pub struct State {
    pub focused: HWND,
    pub captured: HWND,
    raw_registered: bool,
    raw_next: u32,
    raw_packets: std::collections::HashMap<u32,(i32,i32)>,
    wndclasses: Vec<std::rc::Rc<WndClass>>,
    pub user_window_message_count: u32,
    pub windows: Handles<HWND, Window>,
    messages: std::collections::VecDeque<MSG>,
    timers: Timers,
}
