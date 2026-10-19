#!/bin/bash
NAME="com.codex_translate.bridge"
find "$HOME/Library/Application Support" -maxdepth 4 -path "*NativeMessagingHosts/$NAME.json" -print -delete 2>/dev/null
# Removes the bridge, its state.json and the installed extension copy.
rm -rf "$HOME/Library/Application Support/codex-translate"
echo "removed (브라우저의 chrome://extensions 에서 확장도 삭제하세요)"
echo "로그는 남겨 두었어요: ~/Library/Logs/codex-translate.log"
