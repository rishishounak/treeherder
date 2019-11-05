# Generated by Django 2.2.6 on 2019-10-14 14:36

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('perf', '0018_add_measurement_units'),
    ]

    operations = [
        migrations.AlterField(
            model_name='performancealert',
            name='status',
            field=models.IntegerField(
                choices=[(0, 'Untriaged'), (1, 'Downstream'), (2, 'Reassigned'), (3, 'Invalid'), (4, 'Acknowledged')],
                default=0),
        ),
        migrations.AlterField(
            model_name='performancealertsummary',
            name='status',
            field=models.IntegerField(choices=[(0, 'Untriaged'), (1, 'Downstream'), (2, 'Reassigned'), (3, 'Invalid'), (4, 'Improvement'), (5, 'Investigating'), (6, "Won't fix"), (7, 'Fixed'), (8, 'Backed out')], default=0),
        ),
    ]