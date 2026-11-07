"""Add support_documents and thematic_segments tables

Revision ID: a7c3e91f5b20
Revises: 63d7ca28fc0c
Create Date: 2026-11-06 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'a7c3e91f5b20'
down_revision = '63d7ca28fc0c'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'support_documents',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=512), nullable=False),
        sa.Column('kind', sa.String(length=32), nullable=False),
        sa.Column('contents', sa.Text(), nullable=False),
        sa.Column('created', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ['project_id'], ['projects.id'],
            name=op.f('fk_support_documents_project_id_projects'),
            ondelete='CASCADE',
        ),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_support_documents')),
    )
    with op.batch_alter_table('support_documents', schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f('ix_support_documents_project_id'),
            ['project_id'], unique=False,
        )

    op.create_table(
        'thematic_segments',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('position', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=512), nullable=False),
        sa.Column('description', sa.Text(), nullable=False),
        sa.Column('guide_questions', sa.Text(), nullable=False),
        sa.Column('source', sa.String(length=16), nullable=False),
        sa.Column('created', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ['project_id'], ['projects.id'],
            name=op.f('fk_thematic_segments_project_id_projects'),
            ondelete='CASCADE',
        ),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_thematic_segments')),
    )
    with op.batch_alter_table('thematic_segments', schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f('ix_thematic_segments_project_id'),
            ['project_id'], unique=False,
        )


def downgrade():
    with op.batch_alter_table('thematic_segments', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_thematic_segments_project_id'))
    op.drop_table('thematic_segments')
    with op.batch_alter_table('support_documents', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_support_documents_project_id'))
    op.drop_table('support_documents')
