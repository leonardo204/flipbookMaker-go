//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa
#include "native_menu_darwin.h"
*/
import "C"

func installNativeEditMenu() {
	C.flipmd_install_native_edit_menu()
}
