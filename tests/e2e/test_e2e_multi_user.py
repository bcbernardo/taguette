import asyncio
import json
import os
import re
import tempfile
import unittest
from urllib.parse import urlencode

from tornado.testing import gen_test

from taguette import database, main, web
from taguette import exact_version
from tests.e2e.selenium_wrapper import SeleniumTest

if 'TAGUETTE_TEST_DB' in os.environ:
    DATABASE_URI = os.environ['TAGUETTE_TEST_DB']
else:
    DATABASE_URI = 'sqlite://'
if 'TAGUETTE_TEST_REDIS' in os.environ:
    REDIS = os.environ['TAGUETTE_TEST_REDIS']
else:
    REDIS = None


async def set_dumb_password(bd_session):
    db = bd_session()
    admin = database.User(login='admin')
    await admin.set_password('hackme')
    db.add(admin)
    db.commit()
    db.close()


@unittest.skipUnless(
    os.environ.get('TAGUETTE_TEST_WEBDRIVER', ''),
    "TAGUETTE_TEST_WEBDRIVER not set",
)
class Test2E2MultiUser(SeleniumTest):
    # Multi-user specific configurations
    def get_app(self):
        self.base_path = os.environ.get('TAGUETTE_TEST_BASE_PATH', '')
        self.application = web.make_app(dict(
            main.DEFAULT_CONFIG,
            NAME="Test Taguette instance", PORT=7465,
            DATABASE=DATABASE_URI,
            BASE_PATH=self.base_path,
            REDIS_SERVER=REDIS,
            TOS_FILE=None,
            ALLOW_EXTERNAL_LOGIN=False,
            EMAIL='test@example.com',
            MAIL_SERVER={'host': 'localhost', 'port': 25},
            COOKIES_PROMPT=True,
            MULTIUSER=True,
            SECRET_KEY='2PbQ/5Rs005G/nTuWfibaZTUAo3Isng3QuRirmBK',
        ))
        self.io_loop.run_sync(
            lambda: set_dumb_password(self.application.DBSession)
        )
        return self.application

    @gen_test(timeout=120)
    async def test_login(self):
        # Fetch index, should have welcome message and register link
        await self.s_get('/')
        self.assertEqual(self.driver.title, 'Welcome | LibreQDA')
        self.assertEqual(
            [el.text for el in self.find_by_tag('h1')],
            ['Welcome'],
        )
        self.assertIn(
            'Register now',
            [el.text for el in self.find_by_tag('a')],
        )

        # Only admin so far
        db = self.application.DBSession()
        self.assertEqual([user.login
                          for user in db.query(database.User).all()],
                         ['admin'])

        # Fetch registration page, should hit cookies prompt
        await self.s_get('/register')
        self.assertEqual(
            self.s_path,
            '/cookies?' + urlencode({'next': self.base_path + '/register'}),
        )

        # Accept cookies
        await self.s_click_button_by_text('Accept cookies')
        self.assertEqual(self.s_path, '/register')

        # Register
        self.set_value('register-login', 'Tester')
        self.set_value('register-password1', 'hacktoo')
        self.set_value('register-password2', 'hacktoo')
        await self.s_click_button('register-button')

        # User exists in database
        db = self.application.DBSession()
        self.assertEqual([user.login
                          for user in db.query(database.User).all()],
                         ['admin', 'tester'])

        # Fetch index, should have project list
        await self.s_get('/')
        self.assertEqual(
            [el.text for el in self.find_by_tag('h1')],
            ['Welcome tester', 'Bienvenue sur LibreQDA, un logiciel d\'analyse qualitative développé en code source libre ouvert par la Plateforme en humanités numériques de l\'Université de Sherbrooke.'],
        )
        self.assertIn(
            'Here are your projects:',
            [el.text for el in self.find_by_tag('p')],
        )

        # Fetch project creation page
        await self.s_get('/project/new')

        # Create a project
        self.set_value('project-name', 'test project')
        await self.s_click_button('save-project-button')
        self.assertEqual(self.s_path, '/project/1')

        # Log out
        await self.s_get('/logout')
        self.assertEqual(self.s_path, '/')

        # Hit error page
        await self.s_get('/api/project/1/highlights/')
        self.assertNotEqual(
            self.find_by_tag('body')[0].text.find(
                '"Not logged in"',
            ),
            -1,
        )
        logs = self.get_logs()
        if logs is not None:
            self.assertEqual(len(logs), 1)
            self.assertTrue(re.search(
                r'Failed to load resource: the server responded with a status '
                + r'of 403 \(Forbidden\)',
                logs[0]['message'],
            ))

        # Login
        await self.s_get(
            '/login?' + urlencode(dict(next=self.base_path + '/project/1')),
        )
        self.set_value('log-in-login', 'Tester')
        self.set_value('log-in-password', 'hacktoo')
        await self.s_click_button('log-in-button')
        self.assertEqual(self.s_path, '/project/1')

        # Check redirect to account
        await self.s_get('/.well-known/change-password', ignore_base_path=True)
        self.assertEqual(self.s_path, '/account')

    def get_highlight_add_tags(self):
        from selenium.webdriver.common.by import By
        tags = {}

        tags_highlight = (
            self.driver.find_element(By.ID, 'treeview-tags-highlight')
            .find_elements(By.CLASS_NAME, 'node-treeview-tags-highlight')
        )

        for elem in tags_highlight:
            node_id = elem.get_attribute('data-nodeid')
            tag_id = self.driver.execute_script(
                f"""
                var all = $("#treeview-tags-highlight").treeview('getEnabled');
                var node = all.find(item => item.nodeId === {int(node_id)});
                return node.id;
                """
            )
            class_list = elem.get_attribute('class')
            tags[tag_id] = 'node-selected' in class_list.split()
        return tags

    @gen_test(timeout=120)
    async def test_projects(self):
        # project 1
        # ---------
        # create
        # (tag 1 'interesting')
        # tag 2 'people'
        # doc 1
        # change project metadata
        # doc 2
        # hl 1 doc=1 tags=[1]
        # hl 2 doc=1 tags=[1, 2]
        # hl 3 doc=2 tags=[2]
        # tag 3 'interesting.places'
        # hl 1 doc=1 tags=[3] (edit)
        # highlights 'people*': [2, 3]
        # highlights 'interesting.places*': [1]
        # highlights 'interesting*': [1, 2]
        # highlights: [1, 2, 3]
        # export doc 1
        # merge tag 2 -> 1
        # highlights: [1, 2, 3]
        from selenium.webdriver import ActionChains
        from selenium.webdriver.common.by import By
        from selenium.webdriver.common.keys import Keys
        
        # Accept cookies
        await self.s_get('/cookies')
        await self.s_click_button_by_text('Accept cookies')
        self.assertEqual(self.s_path, '/')

        # Log in
        await self.s_get('/login')
        self.set_value('log-in-login', 'admin')
        self.set_value('log-in-password', 'hackme')
        await self.s_click_button('log-in-button')
        self.assertEqual(self.s_path, '/')

        # Create project 1
        await self.s_get('/project/new')
        self.set_value("project-name", "Project 1")
        self.set_value("project-description", "phun's project")
        await self.s_click_button('save-project-button')
        self.assertEqual(self.s_path, '/project/1')

        # Check project page
        expected = (
            '    const user_login = "admin";\n'
            '    const project_id = 1;\n'
            '    const version = \'%s\';\n'
            '    let documents = {};\n'
            '    let tags = %s;\n'
            '    let members = {"admin": {"privileges": "ADMIN"}};\n'
            '    let highlights = {};\n'
            '    let last_event = -1;\n'
            '    let is_demo = false;\n'
        ) % (
            exact_version(),
            json.dumps(
                [
                    {
                        "children": [],
                        "count": 0,
                        "count_document": 0,
                        "color": "#000000",
                        "description": "Further review required",
                        "id": 1,
                        "parent": None,
                        "path": "interesting"
                    },
                ],
                sort_keys=True
            )
        )

        self.assertTrue(any(
            expected.strip() == script.get_property('textContent').strip()
            for script in self.driver.find_elements(By.TAG_NAME, 'script')
        ))
        
        # Remove event listeners in your test setup
        self.driver.execute_script("""
            window.removeEventListener('resize', window.onresize);
            window.onresize = null;
        """)
        
        # Change project 1 metadata
        await self.s_click(self.find_by_id('project-sidebar-open'))
        self.assertEqual(self.find_by_class(
            'project-name')[0].text, 'Project 1')
        await self.s_click_button('project-tab')
        await self.s_perform_action(
            ActionChains(self.driver)
            .click(self.find_by_id('project-name'))
            .key_down(Keys.CONTROL).send_keys('a').key_up(Keys.CONTROL)
            .send_keys('new project').key_up(Keys.CONTROL)
        )
        self.find_by_id('project-description').click()
        await asyncio.sleep(0.5)
        await self.s_perform_action(
            ActionChains(self.driver)
            .key_down(Keys.CONTROL).send_keys('a').key_up(Keys.CONTROL)
        )
        await asyncio.sleep(0.5)
        self.set_value('project-description', 'Meaningful')
        await self.s_click(self.find_by_test_id('close-sidebar-button'))
        await asyncio.sleep(10)  # Wait for XHR
        self.assertEqual(self.find_by_class(
            'project-name')[0].text, 'new project')
        db = self.application.DBSession()
        proj = db.query(database.Project).get(1)
        self.assertEqual(proj.name, 'new project')
        self.assertEqual(proj.description, 'Meaningful')

        # Create tag 2 in project 1
        await self.s_click_button('create-tag-link')
        self.set_value("tag-add-path", "people")
        self.set_value("tag-add-description", "People of interest")
        await self.s_click_button('save-tag-button')

        # Check tags
        tag_links = self.find_children_by_id(
            'treeview-tags', 'node-treeview-tags')
        self.assertEqual(
            [link.text.split('\n')[0] for link in tag_links],
            ['interesting', 'people'],
        )

        # Create document 1 in project 1
        self.driver.execute_script('''
            javascript:createDocument();
        ''')
        # await asyncio.sleep(1)
        # element = self.find_by_test_id('create-document-link')
        # actions = ActionChains(self.driver)
        # actions.move_to_element(element).click().perform()
        docs_1 = []
        with tempfile.NamedTemporaryFile('wb', suffix='.html') as tmp:
            tmp.write(b'different content')
            tmp.flush()
            docs_1.append({
                "path": tmp.name,
                "name": os.path.basename(tmp.name)
            })
            self.set_value("document-add-file", docs_1[0]['path'])
            await self.s_click_button('import-document-button')
        await asyncio.sleep(20)
        db = self.application.DBSession()
        doc = db.query(database.Document).get(1)
        self.assertEqual(doc.name, docs_1[0]['name'])
        self.assertEqual(doc.description, '')
        self.assertEqual(doc.text_direction,
                         database.TextDirection.LEFT_TO_RIGHT)
        self.assertTrue(doc.filename, docs_1[0]['name'])

        # Create document 2 and 3 in project 1
        # await self.s_click_button('create-document-link')
        self.driver.execute_script('''
            javascript:createDocument();
        ''')
        # self.set_value('document-add-description',
        #                'description doc 2 & 3')
        await self.s_click_button('document-add-direction-rtl-input')
        docs_2 = []
        with (tempfile.NamedTemporaryFile('wb', suffix='.html') as tmp,
              tempfile.NamedTemporaryFile('wb', suffix='.html') as tmp2):
            tmp.write(b'<strong>Opinions</strong> and <em>facts</em>!')
            tmp.flush()
            docs_2.append({
                "path": tmp.name,
                "name": os.path.basename(tmp.name)
            })
            self.set_value('document-add-file', docs_2[0]['path'])
            tmp2.write(b'<h1>Document 3</h1><p>This is the 3rd document</p>')
            tmp2.flush()
            docs_2.append({
                "path": tmp2.name,
                "name": os.path.basename(tmp2.name)
            })
            self.set_value('document-add-file', docs_2[1]['path'])
            await self.s_click_button('import-document-button')

        db = self.application.DBSession()
        doc = db.query(database.Document).get(2)
        self.assertEqual(doc.name, docs_2[0]['name'])
        # self.assertEqual(doc.description, 'description doc 2 & 3')
        self.assertEqual(doc.text_direction,
                         database.TextDirection.RIGHT_TO_LEFT)
        self.assertTrue(doc.filename, docs_2[0]['name'])

        doc = db.query(database.Document).get(3)
        self.assertEqual(doc.name, docs_2[1]['name'])
        # self.assertEqual(doc.description, 'description doc 2 & 3')
        self.assertEqual(doc.text_direction,
                         database.TextDirection.RIGHT_TO_LEFT)
        self.assertTrue(doc.filename, docs_2[1]['name'])

        # Check highlight 1 in document 1
        self.assertEqual(
            self.get_highlight_add_tags(),
            {1: False, 2: False}
        )

        # Select document and create highlight 1 and 2
        await self.s_click(
            self.driver.find_element(By.ID, 'document-link-1')
            .find_element(By.CLASS_NAME, 'document-link-a')
        )

        await asyncio.sleep(0.5)
        
        # create highlight 1 - diff
        self.driver.execute_script('restoreSelection([0, 4]);')
        await self.s_click_button_by_text(
            'Select tag',
            tag='a'
        )
        
        # select tag 1 - interesting
        await self.s_click(
            self.find_by_test_id('tag-node-highlight-1'),
        )
        
        await self.s_click_button('save-highlight-button')

        await asyncio.sleep(0.5)

        # Create highlight 2 - tent
        self.driver.execute_script('restoreSelection([13, 17]);')
        await self.s_click_button_by_text(
            'Select tag',
            tag='a'
        )

        # check tags before select
        self.assertEqual(
            self.get_highlight_add_tags(),
            {1: False, 2: False}
        )
        
        # select tag 1 - interesting
        await self.s_click(
            self.find_by_test_id('tag-node-highlight-1'),
        )
        
        # select tag 2 - people
        await self.s_click(
            self.find_by_test_id('tag-node-highlight-2'),
        )

        # check tags after select
        self.assertEqual(
            self.get_highlight_add_tags(),
            {1: True, 2: True}
        )
        
        await self.s_click_button('save-highlight-button')
        
        # check highlighted document 1
        await self.s_get('/project/1/document/1')
        await asyncio.sleep(5)
        self.assertEqual(
            self.find_by_id('document-contents').get_attribute('innerHTML'),
            (
                '<div id="doc-offset-0">'
                + '<div data-line--id="line-0-17" style="height: 65px;"><svg width="100%" height="65px">'
                + '<g data-line--id="line-group-0-17" transform="translate(0, 20)">'
                + '<text x="0" y="0" text-anchor="start">different content</text>'
                + '<line data-highlight-id="1" x1="4" x2="25.3125" y1="10" y2="10" stroke="#000000" '
                + 'stroke-linecap="round" stroke-width="4" class="smooth-stroke"></line>'
                + '<linearGradient id="gradient-2" x1="0%" y1="0%" x2="100%" y2="0%">'
                + '<stop offset="0%" stop-color="#000000"></stop>'
                + '<stop offset="100%" stop-color="#000000"></stop></linearGradient>'
                + '<line data-highlight-id="2" x1="90.84375" x2="117.46875" y1="25" y2="25.1" '
                + 'stroke="url(#gradient-2)" stroke-linecap="round" stroke-width="4" class="smooth-stroke"></line>'
                + '</g></svg></div></div>'
            ),
        )
    
        # Edit highlight 1 in document 1
        hl_1 = self.find_by_path('//*[@data-highlight-id="1"]')
        ActionChains(self.driver).move_to_element(hl_1).click().perform()

        self.assertEqual(
            self.get_highlight_add_tags(),
            {1: True, 2: False}
        )

        # Create tag 3 in project 1
        await asyncio.sleep(0.5)
        await self.s_click_button('create-tag-from-highlight-link')
        await asyncio.sleep(0.5)
        self.set_value("tag-add-path", "interesting.places")
        await self.s_click_button('save-tag-button')
        
        # Finish editing highlight 1 in document 1
        self.assertEqual(
            self.get_highlight_add_tags(),
            # 3 was created while this modal was opened, it should be selected
            {1: True, 3: True, 2: False},
        )
        
        # unselect tag 1 - interesting
        await self.s_click(
            self.find_by_test_id('tag-node-highlight-1'),
        )
        
        self.assertEqual(
            self.get_highlight_add_tags(),
            {1: False, 3: True, 2: False},
        )
        
        await self.s_click_button('save-highlight-button')
        await asyncio.sleep(1)

        tag_links = self.find_children_by_id(
            'treeview-tags', 'node-treeview-tags')
        
        # Check tags list
        self.assertEqual(
            [link.text.split('\n')[0] for link in tag_links],
            ['interesting', 'interesting.places', 'people'],
        )

        # Create highlight 3 in document 2
        await self.s_click(
            self.driver.find_element(By.ID, 'document-link-2')
            .find_element(By.CLASS_NAME, 'document-link-a')
        )

        await asyncio.sleep(0.5)

        # Create highlight 3 - Opinion
        self.driver.execute_script('restoreSelection([0, 7]);')
        await self.s_click_button_by_text(
            'Select tag',
            tag='a'
        )

        # check before select
        self.assertEqual(
            self.get_highlight_add_tags(),
            {1: False, 2: False, 3: False},
        )
        
        # select tag 2 - people
        await self.s_click(
            self.find_by_test_id('tag-node-highlight-2'),
        )
        
        # check after select
        self.assertEqual(
            self.get_highlight_add_tags(),
            {1: False, 3: False, 2: True},
        )
        
        await self.s_click_button('save-highlight-button')
        
        # List highlights in project 1 under 'people'
        await self.s_click(
            self.find_by_test_id('tag-node-2'),
        )
        await asyncio.sleep(1)  # Wait for XHR
        self.assertEqual(self.s_path, '/project/1/highlights/people')
        self.assertEqual(
            self.find_by_id('document-contents').text,
            f"tent\n{docs_1[0]['name']} interesting people\n"
            f"Opinion\n{docs_2[0]['name']} people"
        )

        # List highlights in project 1 under 'interesting.places'
        await self.s_get('/project/1/highlights/interesting.places')
        await asyncio.sleep(1)  # Wait for XHR
        self.assertEqual(
            self.find_by_id('document-contents').text,
            f"diff\n{docs_1[0]['name']} interesting.places"
        )

        # List highlights in project 1 under 'interesting'
        await self.s_get('/project/1/highlights/interesting∪'
                         'interesting.places')
        await asyncio.sleep(1)  # Wait for XHR
        self.assertEqual(
            self.find_by_id('document-contents').text,
            (f"diff\n{docs_1[0]['name']} interesting.places\n"
             f"tent\n{docs_1[0]['name']} interesting people")
        )
        # List all highlights in project 1
        await self.s_click(self.find_by_id('tag-more-action-button'))
        await asyncio.sleep(1)
        await self.s_click_button('see-all-highlights-button')
        await asyncio.sleep(1)  # Wait for XHR
        self.assertEqual(self.s_path, '/project/1/highlights/')
        self.assertEqual(
            self.find_by_id('document-contents').text,
            (f"diff\n{docs_1[0]['name']} interesting.places\n"
             f"tent\n{docs_1[0]['name']} interesting people\n"
             f"Opinion\n{docs_2[0]['name']} people"),
        )

        # Check export options for document 1
        await self.s_get('/project/1/document/1')
        await asyncio.sleep(1)  # Wait for XHR
        await self.s_click_button('document-dropdown-export')
        links = [
            (link.text, self.extract_path(link.get_attribute('href')))
            for link in (
                self.find_by_id('document-export-dropdown-menu')
                .find_elements(By.TAG_NAME, 'a')
            )
            if link.text
        ]
        self.assertEqual(links, [
            ('HTML', self.base_path + '/project/1/export/document/1.html'),
            ('DOCX', self.base_path + '/project/1/export/document/1.docx'),
            ('PDF', self.base_path + '/project/1/export/document/1.pdf'),
        ])
        
        # Check scroll position for highlight 1
        await self.s_get('/project/1/document/1/highlight/1')
        await asyncio.sleep(1)  # Wait for XHR
        self.assertNotEqual(self.s_get_scroll_height(), 0)
        
        # Check export options for highlights in project 1 under 'interesting'
        await self.s_get('/project/1/highlights/interesting')
        await asyncio.sleep(1)  # Wait for XHR
        await self.s_click_button('document-dropdown-export')
        links = [
            (link.text, self.extract_path(link.get_attribute('href')))
            for link in (
                self.find_by_id('document-export-dropdown-menu')
                .find_elements(By.TAG_NAME, 'a')
            )
            if link.text
        ]
        export_url = self.base_path + '/project/1/export'
        self.assertEqual(links, [
            ('HTML', export_url + '/highlights/interesting.html'),
            ('DOCX', export_url + '/highlights/interesting.docx'),
            ('PDF', export_url + '/highlights/interesting.pdf'),
            ('Excel', export_url + '/highlights/interesting.xlsx'),
            ('CSV', export_url + '/highlights/interesting.csv'),
        ])

        # Check codebook export options of project 1
        await self.s_click(self.find_by_id('project-sidebar-open'))
        await self.s_click_button('project-tab')
        await self.s_click_button('dropdown-codebook')
        links = [
            (link.text, self.extract_path(link.get_attribute('href')))
            for link in (
                self.find_by_id('dropdown-codebook')
                .find_element(By.XPATH, './..')
                .find_elements(By.TAG_NAME, 'a')
            )
            if link.text
        ]
        self.assertEqual(links, [
            ('QDC (XML)', self.base_path + '/project/1/export/codebook.qdc'),
            ('Excel', self.base_path + '/project/1/export/codebook.xlsx'),
            ('CSV', self.base_path + '/project/1/export/codebook.csv'),
            ('HTML', self.base_path + '/project/1/export/codebook.html'),
            ('DOCX', self.base_path + '/project/1/export/codebook.docx'),
            ('PDF', self.base_path + '/project/1/export/codebook.pdf'),
        ])
        
        await self.s_click(self.find_by_test_id('close-sidebar-button'))
        await asyncio.sleep(1)
        
        # Merge tag 2 into 1
        ActionChains(self.driver).context_click(self.find_by_test_id('tag-node-2')).perform()
        await asyncio.sleep(1)
        menu_items = self.find_by_class("context-menu-item")
        for item in menu_items:
            if "merge" in item.text:
                await self.s_click(item)
                break
        await asyncio.sleep(0.5)
        await self.s_click(self.find_by_id('dropdownMenuButtonTagMerge'))
        await asyncio.sleep(1)
        target_option = self.driver.find_element(
            By.XPATH,
            "//div[@id='tag-hierarchy-merge-select']"
            "//div[@class='hs-menu-inner']"
            "//a[@data-value='1']"
        )
        await self.s_click(target_option)
        await asyncio.sleep(1)
        await self.s_click_button('merge-tag-button')
        await asyncio.sleep(1)
        tag_links = self.find_children_by_id(
            'treeview-tags', 'node-treeview-tags')

        # check tags
        self.assertEqual(
            [link.text.split('\n')[0] for link in tag_links],
            ['interesting', 'interesting.places'],
        )
        
        # List all highlights in project 1
        await self.s_click(self.find_by_id('tag-more-action-button'))
        await asyncio.sleep(0.5)
        await self.s_click_button('see-all-highlights-button')
        await asyncio.sleep(1)  # Wait for XHR
        self.assertEqual(self.s_path, '/project/1/highlights/')
        self.assertEqual(
            self.find_by_id('document-contents').text,
            (f"diff\n{docs_1[0]['name']} interesting.places\n"
             f"tent\n{docs_1[0]['name']} interesting\n"
             f"Opinion\n{docs_2[0]['name']} interesting"),
        )
