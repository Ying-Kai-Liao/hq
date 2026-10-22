# Homebrew formula

`kith.rb` here is a template: its sha256 values are placeholders. On a `v*` tag the release workflow runs
`scripts/update-formula.sh <version> SHA256SUMS` and attaches the filled `kith.rb` to the GitHub Release.

To publish it, copy that file into the tap repo (`Ying-Kai-Liao/homebrew-kith`, created by hand) as
`Formula/kith.rb`, commit and push. Then `brew install Ying-Kai-Liao/kith/kith` works.

To fill it locally: `scripts/update-formula.sh 1.2.3 SHA256SUMS > kith.rb`.
