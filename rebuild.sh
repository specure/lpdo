#!/usr/bin/env bash
set -e
echo $(date -u) "Step 1/7: Deleting the database"
rm ~/.chess-db/chess.db
echo $(date -u) "Step 2/7: Importing players"
./target/release/chess-db players import ~/.chess-db/players.csv
echo $(date -u) "Step 3/7: Importing Megabase 2025"
./target/release/chess-db import-pgn ~/.chess-db/Megabase2025/Megabase/ --max-position-depth 0 --fast
echo $(date -u) "Step 4/7: Importing 2025 Updates"
./target/release/chess-db import-pgn ~/.chess-db/Megabase2025/Updates/ --max-position-depth 0 --fast
echo $(date -u) "Step 5/7: Downloading TWIC issues"
./target/release/chess-db download
echo $(date -u) "Step 6/7: Importing TWIC issues"
./target/release/chess-db import --fast
echo $(date -u) "Step 7/7: Importing Bundesliga games"
./target/release/chess-db import-pgn ~/.chess-db/Bundesliga/ --max-position-depth 0 --fast
echo "Replacing players' names"
./target/release/chess-db players merge-by-name "Shengelia, David" "Shengelia, Davit" --yes
echo $(date -u) "Finished"
