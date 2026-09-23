"""add Tag.parent_id

Revision ID: 8f2a1b9c0d1e
Revises: db5e31a0233d
Create Date: 2026-09-19 19:45:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '8f2a1b9c0d1e'
down_revision = 'db5e31a0233d'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('tags') as batch_op:
        batch_op.add_column(sa.Column('parent_id', sa.Integer(), nullable=True))
        batch_op.create_foreign_key('fk_tags_parent_id_tags', 'tags', ['parent_id'], ['id'], ondelete='RESTRICT')
        batch_op.create_index(batch_op.f('ix_tags_parent_id'), ['parent_id'])


def downgrade():
    with op.batch_alter_table('tags') as batch_op:
        batch_op.drop_index(batch_op.f('ix_tags_parent_id'))
        batch_op.drop_constraint('fk_tags_parent_id_tags', type_='foreignkey')
        batch_op.drop_column('parent_id')
