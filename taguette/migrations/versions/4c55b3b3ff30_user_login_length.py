"""user login length

Revision ID: 4c55b3b3ff30
Revises: 68a144874e3f
Create Date: 2024-03-11 09:31:27.003711

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '4c55b3b3ff30'
down_revision = '68a144874e3f'
branch_labels = None
depends_on = None


def upgrade():
    op.alter_column('users', 'login',
                    existing_type=sa.VARCHAR(length=30),
                    type_=sa.String(length=255),
                    existing_nullable=True)
    op.alter_column('project_members', 'user_login',
                    existing_type=sa.VARCHAR(length=30),
                    type_=sa.String(length=255),
                    existing_nullable=True)
    op.alter_column('commands', 'user_login',
                    existing_type=sa.VARCHAR(length=30),
                    type_=sa.String(length=255),
                    existing_nullable=True)


def downgrade():
    op.alter_column('users', 'login',
                    existing_type=sa.VARCHAR(length=255),
                    type_=sa.String(length=30),
                    existing_nullable=True)
    op.alter_column('project_members', 'user_login',
                    existing_type=sa.VARCHAR(length=255),
                    type_=sa.String(length=30),
                    existing_nullable=True)
    op.alter_column('commands', 'user_login',
                    existing_type=sa.VARCHAR(length=255),
                    type_=sa.String(length=30),
                    existing_nullable=True)
