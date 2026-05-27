//go:build !darwin && !windows

package nodepath

func osNodeCandidates(_ string) []string {
	return []string{
		"/usr/local/bin/node",
		"/usr/bin/node",
	}
}

func osClaudeCandidates() []string {
	return []string{
		"/usr/local/bin/claude",
		"/usr/bin/claude",
	}
}

func osNpmGlobalRootCandidates(_ string) []string {
	return []string{
		"/usr/local/lib/node_modules",
		"/usr/lib/node_modules",
	}
}
