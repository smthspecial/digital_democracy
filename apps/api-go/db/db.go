// Package db embeds the migration files (db/migrations/*.sql) for the
// hand-rolled runner in internal/pg. The files stay plain tool-agnostic
// numbered SQL (ARCH-023 §Overview); embedding only controls how the app
// reads them at boot.
package db

import "embed"

//go:embed migrations/*.sql
var Files embed.FS
