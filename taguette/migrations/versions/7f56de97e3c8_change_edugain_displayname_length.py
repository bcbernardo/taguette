"""change edugain displayname length

Revision ID: 7f56de97e3c8
Revises: fbdc29566f62
Create Date: 2024-04-04 21:56:27.801558

"""
from alembic import op
import sqlalchemy as sa
import logging

logger = logging.getLogger(__name__)

# revision identifiers, used by Alembic.
revision = '7f56de97e3c8'
down_revision = 'fbdc29566f62'
branch_labels = None
depends_on = None


def upgrade():
    db_url = op.get_context().config.get_section('alembic')['sqlalchemy.url']
    if db_url.startswith('sqlite:'):
        # SQLite doesn't mind field length
        logger.info(f"Skipping upgrade {revision} for SQLite")
    else:
        op.alter_column('edigainidps', 'e_displayname',
                        existing_type=sa.VARCHAR(length=255),
                        type_=sa.Text(),
                        existing_nullable=True)


def downgrade():
    db_url = op.get_context().config.get_section('alembic')['sqlalchemy.url']
    if db_url.startswith('sqlite:'):
        # SQLite doesn't mind field length
        logger.info(f"Skipping downgrade {down_revision} for SQLite")
    else:
        op.alter_column('edigainidps', 'e_displayname',
                        existing_type=sa.Text(),
                        type_=sa.VARCHAR(length=255),
                        existing_nullable=True)
