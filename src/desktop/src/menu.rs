use tauri::{
    menu::{MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    Manager,
};

pub fn build_menu<R: tauri::Runtime>(app: &impl Manager<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    let about = PredefinedMenuItem::about(app, Some("About FBI"), None)?;
    let check_updates = MenuItem::with_id(
        app,
        "check-updates",
        "Check for Updates…",
        true,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("cmd+,"))?;
    let hide = PredefinedMenuItem::hide(app, Some("Hide FBI"))?;
    let hide_others = PredefinedMenuItem::hide_others(app, Some("Hide Others"))?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit FBI"))?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;

    let fbi_menu = SubmenuBuilder::new(app, "FBI")
        .item(&about)
        .item(&check_updates)
        .item(&sep)
        .item(&settings)
        .item(&sep2)
        .item(&hide)
        .item(&hide_others)
        .item(&sep3)
        .item(&quit)
        .build()?;

    let undo = PredefinedMenuItem::undo(app, None)?;
    let redo = PredefinedMenuItem::redo(app, None)?;
    let cut = PredefinedMenuItem::cut(app, None)?;
    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;
    let edit_sep = PredefinedMenuItem::separator(app)?;
    let edit_sep2 = PredefinedMenuItem::separator(app)?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&undo)
        .item(&redo)
        .item(&edit_sep)
        .item(&cut)
        .item(&copy)
        .item(&paste)
        .item(&edit_sep2)
        .item(&select_all)
        .build()?;

    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let zoom = PredefinedMenuItem::maximize(app, None)?;
    let close = PredefinedMenuItem::close_window(app, None)?;
    let win_sep = PredefinedMenuItem::separator(app)?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&minimize)
        .item(&zoom)
        .item(&win_sep)
        .item(&close)
        .build()?;

    let kb_shortcuts = MenuItem::with_id(
        app,
        "keyboard-shortcuts",
        "Keyboard Shortcuts…",
        true,
        None::<&str>,
    )?;
    let github_issues = MenuItem::with_id(
        app,
        "github-issues",
        "Open GitHub Issues…",
        true,
        None::<&str>,
    )?;

    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&kb_shortcuts)
        .item(&github_issues)
        .build()?;

    MenuBuilder::new(app)
        .item(&fbi_menu)
        .item(&edit_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()
}
