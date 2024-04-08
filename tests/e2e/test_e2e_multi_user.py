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
        self.assertEqual(self.driver.title, 'Welcome | Taguette')
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
            ['Welcome tester'],
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
        # from selenium.webdriver import ActionChains
        from selenium.webdriver.common.by import By
        # from selenium.webdriver.common.keys import Keys
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
        # await self.s_click_button('documents-tab')
        # await self.s_click_button('create-document-link')
        self.driver.execute_script('''
            javascript:createDocument();
        ''')
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
        db = self.application.DBSession()
        doc = db.query(database.Document).get(1)
        self.assertEqual(doc.name, docs_1[0]['name'])
        self.assertEqual(doc.description, '')
        self.assertEqual(doc.text_direction,
                         database.TextDirection.LEFT_TO_RIGHT)
        self.assertTrue(doc.filename, docs_1[0]['name'])

        # Change project 2 metadata
        # await self.s_click(self.find_by_id('project-sidebar-open'))
        # self.driver.execute_script('''
        #     javascript:openSidebar();
        # ''')
        # self.assertEqual(self.find_by_class(
        #     'project-name')[0].text, 'Project 1')
        # await self.s_click_button('project-tab')
        # await self.s_perform_action(
        #     ActionChains(self.driver)
        #     .click(self.find_by_id('project-name'))
        #     # .key_down(Keys.CONTROL).send_keys('a').key_up(Keys.CONTROL)
        #     .send_keys('new project').key_up(Keys.CONTROL)
        # )
        # self.find_by_id('project-description').click()
        # await asyncio.sleep(0.5)
        # await self.s_perform_action(
        #     ActionChains(self.driver)
        #     .key_down(Keys.CONTROL).send_keys('a').key_up(Keys.CONTROL)
        # )
        # await asyncio.sleep(0.5)
        # self.set_value('project-description', 'Meaningful')
        # await self.s_click(self.find_by_id('document-contents'))
        # await asyncio.sleep(10)  # Wait for XHR
        # print(self.find_by_class(
        #     'project-name')[0].text)
        # self.assertEqual(self.find_by_class(
        #     'project-name')[0].text, 'new project')
        # db = self.application.DBSession()
        # proj = db.query(database.Project).get(1)
        # self.assertEqual(proj.name, 'new project')
        # self.assertEqual(proj.description, 'Meaningful')
        # Create document 2 and 3 in project 1
        # await self.s_click_button('documents-tab')
        # await self.s_click_button('create-document-link')
        # self.driver.execute_script('$(document_add_modal).modal("hide");')

        self.driver.execute_script('''
            javascript:createDocument();
        ''')
        self.set_value('document-add-description',
                       'description doc 2 & 3')
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
        self.assertEqual(doc.description, 'description doc 2 & 3')
        self.assertEqual(doc.text_direction,
                         database.TextDirection.RIGHT_TO_LEFT)
        self.assertTrue(doc.filename, docs_2[0]['name'])

        doc = db.query(database.Document).get(3)
        self.assertEqual(doc.name, docs_2[1]['name'])
        self.assertEqual(doc.description, 'description doc 2 & 3')
        self.assertEqual(doc.text_direction,
                         database.TextDirection.RIGHT_TO_LEFT)
        self.assertTrue(doc.filename, docs_2[1]['name'])

        # Check highlight 1 in document 1
        self.assertEqual(
            self.get_highlight_add_tags(),
            {1: False, 2: False}
        )

        await self.s_get('/project/1/document/1')
        await asyncio.sleep(0.5)

        # create highlight 1 diff
        self.driver.execute_script('restoreSelection([0, 4]);')
        await self.s_click_button_by_text(
            'Select tag',
            tag='a'
        )
        self.driver.execute_script('''
            $("#treeview-tags-highlight").treeview("selectNode", 0);
        ''')
        await self.s_click_button('save-highlight-button')

        await asyncio.sleep(0.5)

        # Create highlight 2 tent
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

        self.driver.execute_script("""
              $("#treeview-tags-highlight").treeview("selectNode", 0);
              """)
        self.driver.execute_script("""
              $("#treeview-tags-highlight").treeview("selectNode", 1);
              """)

        # check tags after select
        self.assertEqual(
            self.get_highlight_add_tags(),
            {1: True, 2: True}
        )

        await self.s_click_button('save-highlight-button')

        await asyncio.sleep(0.5)

        # Check highlighted document 1
        self.assertEqual(
            self.find_by_id('document-contents').get_attribute('innerHTML'),
            (
                '<div id="doc-offset-0" class="draggable" '
                + 'contenteditable="true">'
                + '<a class="highlight highlight-1" '
                + 'data-highlight-id="1" title="interesting" '
                + 'style="cursor: pointer; border-bottom: 4px solid #000000;">'
                + 'diff</a>erent con'
                + '<a class="highlight highlight-2" data-highlight-id="2" '
                + 'title="interesting, people" '
                + 'style="cursor: pointer; '
                + 'border-bottom: 4px solid transparent; '
                + 'border-image: linear-gradient(90deg, #000000, #000000); '
                + 'border-image-slice: 1;">tent</a></div>'
            ),
        )

        # Edit highlight 1 in document 1
        hl, = self.find_by_class('highlight-1')
        await self.s_click(hl)

        self.assertEqual(
            self.get_highlight_add_tags(),
            {1: True, 2: False}
        )

        await self.s_click_button('save-highlight-button')

        # Create tag 3 in project 1
        await self.s_click_button('create-tag-link')
        self.set_value("tag-add-path", "interesting.places")
        await self.s_click_button('save-tag-button')

        # Finish editing highlight 1 in document 1
        hl, = self.find_by_class('highlight-1')
        await self.s_click(hl)

        self.driver.execute_script(
            '$("#treeview-tags-highlight").treeview("selectNode", 1);')

        self.assertEqual(
            self.get_highlight_add_tags(),
            {1: True, 3: True, 2: False},
        )
        self.driver.execute_script(
            '$("#treeview-tags-highlight").treeview("unselectNode", 0);')
        self.assertEqual(
            self.get_highlight_add_tags(),
            {1: False, 3: True, 2: False},
        )
        await self.s_click_button('save-highlight-button')

        tag_links = self.find_children_by_id(
            'treeview-tags', 'node-treeview-tags')

        self.assertEqual(
            [link.text.split('\n')[0] for link in tag_links],
            ['interesting', 'interesting.places', 'people'],
        )

        # Create highlight 3 in document 2
        await self.s_get('/project/1/document/2')
        await asyncio.sleep(0.5)

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
        self.driver.execute_script(
            '$("#treeview-tags-highlight").treeview("selectNode", 2);')
        # check after select
        self.assertEqual(
            self.get_highlight_add_tags(),
            {1: False, 2: False, 3: True},
        )
        await self.s_click_button('save-highlight-button')

        # List highlights in project 1 under 'people'
        self.driver.execute_script(
            '$("#treeview-tags").treeview("selectNode", 1);')
        await asyncio.sleep(1)  # Wait for XHR
        self.assertEqual(self.s_path, '/project/1/highlights/people')
        self.assertEqual(
            self.find_by_id('document-contents').text,
            f"tent\n{docs_1[0]['name']} interesting people"
        )

        # List highlights in project 1 under 'interesting.places'
        await self.s_get('/project/1/highlights/interesting.places')
        await asyncio.sleep(1)  # Wait for XHR
        self.assertEqual(
            self.find_by_id('document-contents').text,
            (f"diff\n{docs_1[0]['name']} interesting.places\n"
             f"Opinion\n{docs_2[0]['name']} interesting.places")
        )

        # List highlights in project 1 under 'interesting'
        await self.s_get('/project/1/highlights/interesting∪'
                         'interesting.places')
        await asyncio.sleep(1)  # Wait for XHR
        self.assertEqual(
            self.find_by_id('document-contents').text,
            (f"diff\n{docs_1[0]['name']} interesting.places\n"
             f"tent\n{docs_1[0]['name']} interesting people\n"
             f"Opinion\n{docs_2[0]['name']} interesting.places")
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
             f"Opinion\n{docs_2[0]['name']} interesting.places"),
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

        # # Check codebook export options of project 1
        await self.s_click(self.find_by_id('project-sidebar-open'))
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

        # Merge tag 2 into 1
        # await self.s_click_button('tags-tab')
        # self.driver.execute_script(
        #     '$("#treeview-tags").treeview("selectNode", 1);')
        # await asyncio.sleep(1)  # Wait for XHR
        # edit_button = self.find_by_path('//*[@data-nodeid="1"]')
        # await self.s_click_button_by_text(
        #     'Edit',
        #     tag='a',
        #     parent=edit_button
        # )
        # await self.s_click_button('show-merge-tag-modal-button')
        # await self.s_click(self.find_by_id('dropdownMenuButtonTagMerge'))
        # await asyncio.sleep(2)
        #
        # parent = (
        #     self.find_by_test_id('hs-menu-inner-tag-merge')
        # )
        #
        # await self.s_click_button_by_text(
        #     'interesting',
        #     tag='a',
        #     parent=parent
        # )
        #
        # await self.s_click_button('merge-tag-button')
        #
        # tag_links = self.find_children_by_id(
        #     'treeview-tags', 'node-treeview-tags')
        #
        # # check tags
        # self.assertEqual(
        #     [link.text.split('\n')[0] for link in tag_links],
        #     ['interesting', 'interesting.places'],
        # )
        #
        # self.driver.execute_script(
        #     '$("#tag-add-modal").modal("hide")'
        # )
        #
        # await asyncio.sleep(1)
        # List all highlights in project 1
        # await self.s_click(self.find_by_id('tags-tab'))
        # await self.s_click_button('see-all-highlights-button')
        # await asyncio.sleep(1)  # Wait for XHR
        # self.assertEqual(self.s_path, '/project/1/highlights/')
        # self.assertEqual(
        #     self.find_by_id('document-contents').text,
        #     (f"diff\n{docs_1[0]['name']} interesting.places\n"
        #      f"tent\n{docs_1[0]['name']} interesting\n"
        #      f"Opinion\n{docs_2[0]['name']} interesting"),
        # )
