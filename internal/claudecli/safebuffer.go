package claudecli

import (
	"bytes"
	"sync"
)

// safeBuffer is a goroutine-safe wrapper around bytes.Buffer. exec.Cmd may
// write to Stdout/Stderr from multiple goroutines when pipes are involved.
type safeBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *safeBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *safeBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
