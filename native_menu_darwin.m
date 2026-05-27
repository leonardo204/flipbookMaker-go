// +build darwin
#import <Cocoa/Cocoa.h>
#import "native_menu_darwin.h"

static NSMenu *flipmd_build_edit_menu(void) {
    NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];

    NSMenuItem *undo = [[NSMenuItem alloc] initWithTitle:@"Undo"
                                                  action:@selector(undo:)
                                           keyEquivalent:@"z"];
    [editMenu addItem:undo];

    NSMenuItem *redo = [[NSMenuItem alloc] initWithTitle:@"Redo"
                                                  action:@selector(redo:)
                                           keyEquivalent:@"z"];
    redo.keyEquivalentModifierMask =
        NSEventModifierFlagCommand | NSEventModifierFlagShift;
    [editMenu addItem:redo];

    [editMenu addItem:[NSMenuItem separatorItem]];

    NSMenuItem *cut = [[NSMenuItem alloc] initWithTitle:@"Cut"
                                                 action:@selector(cut:)
                                          keyEquivalent:@"x"];
    [editMenu addItem:cut];

    NSMenuItem *copyItem = [[NSMenuItem alloc] initWithTitle:@"Copy"
                                                      action:@selector(copy:)
                                               keyEquivalent:@"c"];
    [editMenu addItem:copyItem];

    NSMenuItem *paste = [[NSMenuItem alloc] initWithTitle:@"Paste"
                                                   action:@selector(paste:)
                                            keyEquivalent:@"v"];
    [editMenu addItem:paste];

    NSMenuItem *selectAll = [[NSMenuItem alloc] initWithTitle:@"Select All"
                                                       action:@selector(selectAll:)
                                                keyEquivalent:@"a"];
    [editMenu addItem:selectAll];

    return editMenu;
}

void flipmd_install_native_edit_menu(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSMenu *mainMenu = [NSApp mainMenu];
        if (!mainMenu) {
            return;
        }

        // Find any existing "Edit" submenu inserted by Wails and replace its
        // contents; otherwise insert a new Edit item right after the app menu.
        NSInteger existingIdx = -1;
        for (NSInteger i = 0; i < [mainMenu numberOfItems]; i++) {
            NSMenuItem *item = [mainMenu itemAtIndex:i];
            if ([item.title isEqualToString:@"Edit"]) {
                existingIdx = i;
                break;
            }
        }

        NSMenu *newSubmenu = flipmd_build_edit_menu();

        if (existingIdx >= 0) {
            NSMenuItem *editItem = [mainMenu itemAtIndex:existingIdx];
            editItem.submenu = newSubmenu;
            editItem.title = @"Edit";
        } else {
            NSMenuItem *editItem = [[NSMenuItem alloc] initWithTitle:@"Edit"
                                                              action:nil
                                                       keyEquivalent:@""];
            editItem.submenu = newSubmenu;
            NSInteger insertAt = [mainMenu numberOfItems] >= 1 ? 1 : 0;
            [mainMenu insertItem:editItem atIndex:insertAt];
        }
    });
}
