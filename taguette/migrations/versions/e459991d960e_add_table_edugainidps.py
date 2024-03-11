"""add table edugainidps

Revision ID: e459991d960e
Revises: 4c55b3b3ff30
Create Date: 2024-03-11 10:16:16.804208

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'e459991d960e'
down_revision = '4c55b3b3ff30'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'edigainidps',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('entityid', sa.String(length=255), nullable=True),
        sa.Column('e_displayname', sa.String(length=255), nullable=True),
        sa.Column('regauth', sa.String(length=255), nullable=True),
        sa.Column('entity_cat', sa.String(length=255), nullable=True),
        sa.Column('eccs_status', sa.Integer(), nullable=True),
        sa.Column('validator_status', sa.BigInteger(), nullable=True),
        sa.Column('coco_status', sa.String(length=255), nullable=True),
        sa.Column('coco_id', sa.Integer(), nullable=True),
        sa.Column('sirtfi_status', sa.Integer(), nullable=True),
        sa.Column('code', sa.String(length=255), nullable=True),
        sa.Column('scopes', sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_edigainidps'))
    )


def downgrade():
    op.drop_table('edigainidps')
