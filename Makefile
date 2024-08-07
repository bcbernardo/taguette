#Todo : check if poetry is installed before run make command
#Update README

STEP = "\\n\\r**************************************************\\n"
JOBS := sqlite3 sqlite3_redis frontend_firefox frontend_chromium_redis frontend_chromium_subdir sqlite3_latest sqlite3_latest_pip postgres mariadb sqlite3_pypy

help:
	@echo " "
	@echo "-- install: install taguette (to run the first time you wan to launch the project)";
	@echo "-- env: Entering in poetry shell";
	@echo "-- up: start taguette";
	@echo "-- test: test taguette";
	@echo " "

install:
	@echo "$(STEP) install taguette... $(STEP)";
	@echo "-- Incoming --";

env:
	@echo "$(STEP) Entering virtual environment... $(STEP)"
	@poetry shell
	@echo "$(STEP) wait an execute others make command or make help... $(STEP)"

up:
	@echo "$(STEP) Starting up taguette ... $(STEP)";
	@taguette --debug server taguette.conf
	@echo "$(STEP) Finished! $(STEP)";

test:
	@echo "$(STEP) Start test by using local gitlab-runner ... $(STEP)"
	@for job in $(JOBS); do \
		echo "$(STEP) Start job $$job ... $(STEP)"; \
		./tests/rungit.sh job $$job; \
		echo "$(STEP) Finished job $$job! $(STEP)"; \
		sleep 2; \
	done
	@echo "$(STEP) Finished! $(STEP)"

test-main:
	@echo "$(STEP) Start test by using local gitlab-runner ... $(STEP)"
	./tests/rungit.sh job sqlite3; \
	sleep 1; \
	./tests/rungit.sh job sqlite3_redis; \
	sleep 1; \
	./tests/rungit.sh job frontend_firefox; \
	sleep 1; \
	./tests/rungit.sh job frontend_chromium_redis; \
	sleep 1;
	@echo "$(STEP) Finished! $(STEP)"