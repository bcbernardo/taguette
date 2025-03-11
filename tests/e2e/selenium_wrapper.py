from tests.http_test_case import MyHTTPTestCase

import asyncio
import concurrent.futures
import re
import os


class SeleniumTest(MyHTTPTestCase):
    def setUp(self):
        super(SeleniumTest, self).setUp()

        from selenium import webdriver
        if os.environ['TAGUETTE_TEST_WEBDRIVER'] == 'firefox':
            self.driver = webdriver.Firefox()
        elif os.environ['TAGUETTE_TEST_WEBDRIVER'] == 'chromium':
            from selenium.webdriver.chrome.options import Options
            options = Options()
            options.add_argument('--disable-gpu')
            options.add_argument('--disable-dev-shm-usage')
            options.add_argument('--no-sandbox')
            options.binary_location = '/usr/bin/google-chrome'
            chrome_driver_binary = "/usr/bin/chromedriver"
            self.driver = webdriver.Chrome(chrome_driver_binary, options=options)
        else:
            raise EnvironmentError
        self.driver.set_window_size(1024, 768)
        self.driver_pool = concurrent.futures.ThreadPoolExecutor(1)

        self.logs = []

    def tearDown(self):
        super(SeleniumTest, self).tearDown()

        logs = self.get_logs()
        if logs:
            raise ValueError("Error in browser console: %s"
                             % logs[0]['message'])

        self.driver.quit()

    @staticmethod
    def extract_path(url):
        m = re.match('^http://127.0.0.1:[0-9]+(.+)$', url)
        return m.group(1)

    @property
    def s_path(self):
        path = self.extract_path(self.driver.current_url)
        self.assertTrue(
            path.startswith(self.application.config['BASE_PATH']),
            "Not under base path: %r" % path,
        )
        return path[len(self.application.config['BASE_PATH']):]

    async def s_get(self, url, *, ignore_base_path=False):
        self.store_logs()
        if not ignore_base_path:
            url = self.application.config['BASE_PATH'] + url
        url = self.get_url(url)
        await asyncio.get_event_loop().run_in_executor(
            self.driver_pool,
            lambda: self.driver.get(url),
        )
        await asyncio.sleep(0.2)

    async def s_click(self, element):
        self.store_logs()
        await asyncio.get_event_loop().run_in_executor(
            self.driver_pool,
            lambda: element.click(),
        )
        await asyncio.sleep(0.2)

    def find_by_tag(self, tag, parent=None):
        from selenium.webdriver.common.by import By
        if parent is None:
            parent = self.driver
        return parent.find_elements(By.TAG_NAME, tag)

    def find_by_class(self, my_class):
        from selenium.webdriver.common.by import By
        return self.driver.find_elements(By.CLASS_NAME, my_class)

    def find_by_id(self, id):
        from selenium.webdriver.common.by import By
        return self.driver.find_element(By.ID, id)

    def find_by_path(self, path):
        from selenium.webdriver.common.by import By
        return self.driver.find_element(By.XPATH, f'{path}')

    def find_by_test_id(self, test_id):
        return self.find_by_path(f'//*[@data-test-id="{test_id}"]')

    def find_children_by_id(self, id, class_name):
        from selenium.webdriver.common.by import By
        return (
            self.find_by_id(id)
            .find_elements(By.CLASS_NAME, class_name)
        )

    def find_children_by_test_id(self, id, class_name):
        from selenium.webdriver.common.by import By
        return (
            self.find_by_test_id(id)
            .find_elements(By.CLASS_NAME, class_name)
        )

    def set_value(self, test_id, value):
        elem = self.find_by_id(test_id)
        elem.send_keys(value)

    async def s_click_button_by_text(self, text, tag='button', parent=None):
        from selenium.webdriver.common.by import By
        await asyncio.sleep(0.2)
        if parent is None:
            parent = self.driver
        buttons = parent.find_elements(By.TAG_NAME, tag)
        correct_button, = [
            button for button in buttons
            if button.text == text
        ]
        await self.s_click(correct_button)

    async def s_click_button(self, test_id):
        await asyncio.sleep(0.2)
        button = self.find_by_test_id(test_id)
        await self.s_click(button)

    async def s_perform_action(self, action):
        self.store_logs()
        await asyncio.get_event_loop().run_in_executor(
            self.driver_pool,
            lambda: action.perform(),
        )
        await asyncio.sleep(0.2)

    def _filter_logs(self, logs):
        return [
            line
            for line in logs
            if 'Polling failed:' not in line['message']
        ]

    def store_logs(self):
        from selenium import webdriver
        if isinstance(self.driver, webdriver.Chrome):
            logs = self.driver.get_log('browser')
            logs = self._filter_logs(logs)
            if self.logs:
                for i in reversed(range(len(logs))):
                    if logs[i] == self.logs[-1]:
                        self.logs.extend(logs[i + 1:])
                        return
            self.logs.extend(logs)

    def get_logs(self):
        from selenium import webdriver
        if isinstance(self.driver, webdriver.Chrome):
            self.store_logs()
            logs = self.logs
            self.logs = []
            return logs
        else:
            return None

    async def s_get_scroll_height(self):
        await asyncio.sleep(0.2)
        return self.driver.execute_script("return document.body.scrollHeight")
