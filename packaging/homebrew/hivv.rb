# homebrew tap formula — publish at hivv/homebrew-tap/Formula/hivv.rb
#   brew tap hivv/tap && brew install hivv
# Update version + the two sha256 values per release (from the
# build-cli-binaries.yml artifacts: sha256sum hivv-macos-*).
class Hivv < Formula
  desc "The people's distributed AI network - join the hive"
  homepage "https://hivv.org"
  version "0.3.0"
  license "ISC"

  on_macos do
    on_arm do
      url "https://github.com/hivv-org/hivv/releases/download/v#{version}/hivv-macos-arm64"
      sha256 "REPLACE_WITH_SHA256"
    end
    on_intel do
      url "https://github.com/hivv-org/hivv/releases/download/v#{version}/hivv-macos-x86_64"
      sha256 "REPLACE_WITH_SHA256"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/hivv-org/hivv/releases/download/v#{version}/hivv-linux-arm64"
      sha256 "REPLACE_WITH_SHA256"
    end
    on_intel do
      url "https://github.com/hivv-org/hivv/releases/download/v#{version}/hivv-linux-x86_64"
      sha256 "REPLACE_WITH_SHA256"
    end
  end

  def install
    name = if OS.mac? && Hardware::CPU.arm? then "hivv-macos-arm64"
           elsif OS.mac? then "hivv-macos-x86_64"
           elsif Hardware::CPU.arm? then "hivv-linux-arm64"
           else "hivv-linux-x86_64"
           end
    bin.install name => "hivv"
  end

  test do
    assert_match "hivv", shell_output("#{bin}/hivv --healthcheck")
  end
end
