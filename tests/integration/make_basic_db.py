from taguette import database

from .test_multi_user import TestMultiUser


class TestBasicDatabase(TestMultiUser):

    @classmethod
    async def make_basic_db(cls, db, db_num):
        # Populate database
        user = database.User(login='db%duser' % db_num)
        await user.set_password('hackme')
        db.add(user)
        cls.make_basic_project(db, db_num, 1)
        cls.make_basic_project(db, db_num, 2)

    @staticmethod
    def make_basic_project(db, db_num, project_num):
        # Creates 1 project, 2 (+1 deleted) documents, 2 (+1 deleted) tags,
        # 2 (+1 deleted) highlights, 13 commands total
        def doc(project, number, dir=database.TextDirection.LEFT_TO_RIGHT):
            text = 'db%ddoc%d%d' % (db_num, project_num, number)
            return database.Document(
                name=text + '.txt',
                description='',
                favorite=False,
                filename=text + '.txt',
                project=project,
                contents=text,
                text_direction=dir,
            )

        user = 'db%duser' % db_num
        project1 = database.Project(
            name='db%dproject%d' % (db_num, project_num),
            description='',
        )
        db.add(project1)
        db.flush()
        document1 = doc(project1, 1)
        db.add(document1)
        document2 = doc(project1, 2, database.TextDirection.RIGHT_TO_LEFT)
        db.add(document2)
        tag1 = database.Tag(
            project=project1,
            path='db%dtag%d1' % (db_num, project_num),
            color='#000000',
            parent_id=None,
            description='',
        )
        db.add(tag1)
        tag2 = database.Tag(
            project=project1,
            path='db%dtag%d2' % (db_num, project_num),
            color='#000000',
            parent_id=None,
            description='',
        )
        db.add(tag2)
        db.flush()
        hl1 = database.Highlight(
            document_id=document1.id,
            start_offset=3, end_offset=6, snippet='doc',
        )
        hl2 = database.Highlight(
            document_id=document2.id,
            start_offset=3, end_offset=6, snippet='doc',
        )
        db.add(hl1)
        db.add(hl2)
        db.flush()
        hl1.tags.append(tag2)
        hl2.tags.append(tag1)
        db.add(database.ProjectMember(user_login='admin', project=project1,
                                      privileges=database.Privileges.ADMIN))
        db.add(database.ProjectMember(user_login=user,
                                      project=project1,
                                      privileges=database.Privileges.ADMIN))
        db.add(database.Command.document_add(user, document1))
        document_fake = doc(project1, 100)
        db.add(document_fake)
        db.flush()
        db.add(database.Command.document_add(user, document_fake))
        db.add(database.Command.document_add(user, document2))
        db.add(database.Command.document_delete(user, document_fake))
        db.delete(document_fake)
        tag_fake = database.Tag(project=project1,
                                path='db%dtagF' % db_num,
                                color='#000000',
                                parent_id=None,
                                description='')
        db.add(tag_fake)
        db.flush()
        db.add(database.Command.tag_add(user, tag1))
        db.add(database.Command.tag_add(user, tag_fake))
        db.add(database.Command.tag_add(user, tag2))
        db.add(database.Command.tag_delete(user, project1.id, tag_fake.id))
        db.delete(tag_fake)
        hl_fake = database.Highlight(
            document_id=document1.id,
            start_offset=3, end_offset=6, snippet='doc',
        )
        db.add(hl_fake)
        db.flush()
        db.add(database.Command.highlight_add(user, document1, hl1, []))
        db.add(database.Command.highlight_add(user, document1, hl1, [tag2.id]))
        db.add(database.Command.highlight_add(user, document1, hl_fake,
                                              [tag1.id]))
        db.add(database.Command.highlight_add(user, document1, hl2, [tag1.id]))
        db.add(database.Command.highlight_delete(user, document1, hl_fake.id))
        db.delete(hl_fake)

        # Add collections
        collection1 = database.Collection(
            name='db%dcollection%d1' % (db_num, project_num),
            description='Test collection 1',
            project=project1,
            parent_id=None,
        )
        collection2 = database.Collection(
            name='db%dcollection%d2' % (db_num, project_num),
            description='Test collection 2',
            project=project1,
            parent_id=collection1.id,
        )
        db.add(collection1)
        db.add(collection2)
        db.flush()
        db.add(database.Command.collection_add(user, collection1))
        db.add(database.Command.collection_add(user, collection2))
