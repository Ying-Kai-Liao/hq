# Homebrew formula

`kith.rb` here is a template: its sha256 values are placeholders. On a `v*` tag the release workflow runs
`scripts/update-formula.sh <version> SHA256SUMS` and attaches the filled `kith.rb` to the GitHub Release.

The tap is https://github.com/Ying-Kai-Liao/homebrew-kith. Its `Formula/kith.rb` also holds placeholder hashes until the
first release, so `brew install Ying-Kai-Liao/kith/kith` fails the checksum until then. Nothing pushes to the tap
automatically: to publish a release, copy that release's `kith.rb` to `Formula/kith.rb` in the tap by hand, commit and push.

To fill it locally: `scripts/update-formula.sh 1.2.3 SHA256SUMS > kith.rb`.
