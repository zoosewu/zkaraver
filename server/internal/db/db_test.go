package db

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

// A database from before qr_size existed gets the column on open, and opening
// it again is harmless.
func TestOpenAddsColumns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.db")
	old, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(`CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, queue_mode TEXT NOT NULL DEFAULT 'fifo',
		max_per_user INTEGER NOT NULL DEFAULT 0, idle_clear_minutes INTEGER NOT NULL DEFAULT 0,
		show_qr INTEGER NOT NULL DEFAULT 1, volume INTEGER NOT NULL DEFAULT 100, created_at INTEGER NOT NULL);
		INSERT INTO rooms(id, name, created_at) VALUES('ktv', 'ktv', 0)`); err != nil {
		t.Fatal(err)
	}
	old.Close()
	for i := 0; i < 2; i++ {
		d, err := Open(path)
		if err != nil {
			t.Fatalf("open #%d: %v", i+1, err)
		}
		var size int
		if err := d.QueryRow(`SELECT qr_size FROM rooms WHERE id='ktv'`).Scan(&size); err != nil || size != 40 {
			t.Fatalf("open #%d: qr_size = %d, %v", i+1, size, err)
		}
		d.Close()
	}
}
