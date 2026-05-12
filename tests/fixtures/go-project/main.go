// Package main is the entrypoint of the example.
package main

import (
	"fmt"

	"example.com/myrepo/internal/secret"
	pkg "github.com/external/pkg"
)

// Greeting is the message shown at startup.
const Greeting = "hello"

// User represents a registered user.
type User struct {
	// ID is the primary key.
	ID int
	// Name is the display name.
	Name    string
	private bool
}

// Greeter knows how to greet things.
type Greeter interface {
	// Hello returns a greeting for the given name.
	Hello(name string) string
	Goodbye(name string) (string, error)
}

// Hello says hi to a User by name.
func (u *User) Hello(name string) string {
	return fmt.Sprintf("hi %s, I'm %s", name, u.Name)
}

// goodbye is unexported — should NOT appear in exports.
func (u *User) goodbye(name string) string {
	return "bye " + name
}

// Run starts the program.
func Run() error {
	s := secret.Token()
	_ = pkg.Do
	fmt.Println(s)
	return nil
}

func main() {
	_ = Run()
}
