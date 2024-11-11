#git add taguette/database/*.py
#git add tests/e2e/*.py
#git add tests/integration/*.py
#git commit --amend --no-edit
#sleep 1
./tests/rungit.sh job sqlite3
sleep 3
clear
./tests/rungit.sh job frontend_chromium_redis