"""Add color field to tags

Revision ID: f1a2b3c4d5e6
Revises: db5e31a0233d
Create Date: 2026-02-09 17:04:30.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'f1a2b3c4d5e6'
down_revision = 'db5e31a0233d'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('tags',
                  sa.Column('color', sa.String(6),
                            nullable=True, server_default='ffff00'))


def downgrade():
    op.drop_column('tags', 'color')
