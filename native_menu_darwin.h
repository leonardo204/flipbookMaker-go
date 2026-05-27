#ifndef FLIPMD_NATIVE_MENU_DARWIN_H
#define FLIPMD_NATIVE_MENU_DARWIN_H

#ifdef __cplusplus
extern "C" {
#endif

// Installs a native Edit menu (Undo/Redo/Cut/Copy/Paste/Select All) using
// standard NSResponder selectors. Routes through the responder chain so that
// WKWebView's native paste path handles the action — no JS keydown listener,
// no system "Paste" confirmation chip, and IME monitoring (e.g. 한영 표시기)
// keeps working because keys flow through Cocoa normally.
void flipmd_install_native_edit_menu(void);

#ifdef __cplusplus
}
#endif

#endif
