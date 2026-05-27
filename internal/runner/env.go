package runner

import "os"

// inheritedEnv returns a snapshot of the parent process environment so spawned
// node scripts can resolve PATH-based binaries and access user-configured vars.
func inheritedEnv() []string {
	return os.Environ()
}
