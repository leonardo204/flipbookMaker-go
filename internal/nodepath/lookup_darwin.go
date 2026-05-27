//go:build darwin

package nodepath

func osNodeCandidates(_ string) []string {
	return []string{
		"/opt/homebrew/bin/node",
		"/usr/local/bin/node",
		"/usr/bin/node",
	}
}

func osClaudeCandidates() []string {
	return []string{
		"/usr/local/bin/claude",
		"/opt/homebrew/bin/claude",
		"/Applications/cmux.app/Contents/Resources/bin/claude",
	}
}

func osNpmGlobalRootCandidates(_ string) []string {
	return []string{
		"/opt/homebrew/lib/node_modules",
		"/usr/local/lib/node_modules",
	}
}
