"""add user roles

Revision ID: 1b29e68900c1
Revises: e9a9f1c77971
Create Date: 2025-03-10 08:14:24.098419

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = '1b29e68900c1'
down_revision = 'e9a9f1c77971'
branch_labels = None
depends_on = None


def upgrade():
    connection = op.get_bind()
    if connection.dialect.name == 'postgresql':
        roles_enum = postgresql.ENUM(
            'ADMIN', 'PROJECT_ADMIN', 'TEAM_MEMBER',
            name='roles',
            create_type=False,
        )
        roles_enum.create(connection)
    else:
        roles_enum = sa.Enum(
            'ADMIN', 'PROJECT_ADMIN', 'TEAM_MEMBER',
            name='roles',
        )

    op.add_column(
        'users',
        sa.Column('role', roles_enum, nullable=True)
    )
    op.execute(
        '''\
        UPDATE users SET role = 'TEAM_MEMBER';
        ''',
    )

    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.alter_column('role', nullable=False)


def downgrade():
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_column('roles')

    connection = op.get_bind()
    if connection.dialect.name == 'postgresql':
        op.execute("DROP TYPE roles;")
