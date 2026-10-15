import unittest

from scripts.publish_duty import publication_data


class DutyPublicationTests(unittest.TestCase):
    def test_only_ge_fields_and_required_person_details_are_published(self):
        source = {
            "fields": [{
                "module": "GE", "sub_field": "Synthetic",
                "paths": [{"repo": "ge", "prefix": "runtime/v2", "whole_repo": False},
                          {"repo": "other", "prefix": "", "whole_repo": True}],
                "owner": {"name": "Synthetic owner", "email": "private@example.invalid"},
                "committer": {"name": "Synthetic committer", "token": "not-public"},
                "internal_notes": "not-public",
            }],
            "repo_fallbacks": {"ge": {
                "sub_field": "Other", "owner": {"name": "Owner"},
                "committer": {"name": "Committer"}, "internal_notes": "not-public",
            }},
            "files": ["runtime/v2/example.cc"],
            "source_commit": "private-metadata",
        }
        result = publication_data(source)
        self.assertEqual(result["fields"][0]["paths"], source["fields"][0]["paths"][:1])
        self.assertEqual(result["fields"][0]["owner"], {"name": "Synthetic owner"})
        self.assertEqual(result["fields"][0]["committer"], {"name": "Synthetic committer"})
        self.assertNotIn("not-public", str(result))
        self.assertNotIn("private@example.invalid", str(result))
        self.assertNotIn("source_commit", result)
        self.assertEqual(result["files"], source["files"])


if __name__ == "__main__":
    unittest.main()
