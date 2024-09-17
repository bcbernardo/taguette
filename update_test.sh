git add tests/e2e/test_e2e_multi_user.py
git commit --amend --no-edit
sleep 1
./tests/rungit.sh job frontend_chromium_redis
