"""user with parent for permissions

Revision ID: 61a4abcc8769
Revises: 1b29e68900c1
Create Date: 2025-03-10 12:58:30.136770

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '61a4abcc8769'
down_revision = '1b29e68900c1'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.add_column(sa.Column('approved_by_user_login', sa.String(length=255), nullable=True))
        batch_op.create_index(batch_op.f('ix_users_approved_by_user_login'), ['approved_by_user_login'], unique=False)
        batch_op.create_foreign_key(batch_op.f('fk_users_approved_by_user_login_users'), 'users', ['approved_by_user_login'], ['login'], ondelete='CASCADE')


def downgrade():
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_constraint(batch_op.f('fk_users_approved_by_user_login_users'), type_='foreignkey')
        batch_op.drop_index(batch_op.f('ix_users_approved_by_user_login'))
        batch_op.drop_column('approved_by_user_login')
