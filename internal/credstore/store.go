// Package credstore wraps OS credential stores (macOS Keychain, Windows
// Credential Manager, Linux Secret Service) via zalando/go-keyring.
package credstore

import (
	"errors"

	"github.com/zalando/go-keyring"
)

// Save persists value for (service, key). Existing entries are overwritten.
func Save(service, key, value string) error {
	return keyring.Set(service, key, value)
}

// Load returns the value for (service, key). A missing entry yields ("", nil)
// so callers can distinguish absence from real errors.
func Load(service, key string) (string, error) {
	v, err := keyring.Get(service, key)
	if err != nil {
		if errors.Is(err, keyring.ErrNotFound) {
			return "", nil
		}
		return "", err
	}
	return v, nil
}

// Delete removes the entry. A missing entry is treated as success.
func Delete(service, key string) error {
	if err := keyring.Delete(service, key); err != nil {
		if errors.Is(err, keyring.ErrNotFound) {
			return nil
		}
		return err
	}
	return nil
}
