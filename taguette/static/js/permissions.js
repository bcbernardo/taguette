/*
 * Members
 */

function addMember(login, privileges) {
    members[login] = {privileges: privileges};
}

function removeMember(login) {
    delete members[login];
}

let members_initial = {};
let members_displayed = {};

function _memberRow(login, user) {
    let elem = document.createElement('div');
    elem.className = 'row members-item';
    elem.innerHTML = '<div class="col-md-4 text-center">' +
        '  <i class="fas fa-user fa-2x"></i>' +
        '  <p class="members-item-login">' + login + '</p>' +
        '</div>' +
        '<div class="col-md-4 form-group">' +
        '  <select class="form-control">' +
        '    <option value="PROJECT_OWNER">' + gettext("Can create projects") + '</option>' +
        '    <option value="TEAM_MEMBER">' + gettext("Can't create projects") + '</option>' +
        '  </select>' +
        '</div>' +
        '<hr class="custom-hr" />';

    [].forEach.call(elem.querySelectorAll('option'), function (e) {
        if (e.value === user.privileges) {
            e.selected = true;
        }
    });

    return elem;
}

function showMembers() {
    document.getElementById('members-add').reset();
    document.getElementById('members-add-fields').removeAttribute('disabled');

    let entries = Object.entries(members);
    sortByKey(entries, function (e) {
        return e[0];
    });
    log("Members:", entries.map(function (e) {
        return e[0] + " (" + e[1].privileges + ")";
    })
        .join(", "));

    // Empty the list
    let current_members = document.getElementById('members-current');
    current_members.innerHTML = '';

    // Fill it back up
    for (let i = 0; i < entries.length; ++i) {
        const login = entries[i][0];
        const user = entries[i][1];
        const elem = _memberRow(login, user);
        if(login !== user_login) {
            current_members.appendChild(elem);
        }
    }

    // Store current state so that we can compare later
    members_initial = Object.assign({}, members);
    members_displayed = Object.assign({}, members);
}

document.getElementById('members-add').addEventListener('submit', function (e) {
    e.preventDefault();

    const login = document.getElementById('member-add-name').value.toLowerCase();
    if (!login) {
        return;
    }
    const privileges = document.getElementById('member-add-privileges').value;

    // Check login
    if (login in members_displayed) {
        showAlert(gettext("Already a member!"));
        document.getElementById('members-add').reset();
        return;
    }
    postJSON('/api/check_user', {login: login, permission: true})
        .then(function (result) {
            if (result.exists) {
                // Add it at the top
                const elem = _memberRow(login, {privileges: privileges});
                const current_members = document.getElementById('members-current');
                current_members.insertBefore(elem, current_members.firstChild);
                members_displayed[login] = true;

                document.getElementById('members-add').reset();
            } else {
                showAlert(gettext("Cannot add this user<br/>Reasons : <ul><li>User cannot be found</li><li>User is already sponsored</li><li>User role cannot be changed</li></ul>"));
            }
        })
});

function sendMembersPatch() {
    let patch = {};

    let members_before = Object.assign({}, members_initial);

    const rows = document.getElementById('members-current').querySelectorAll('.members-item');
    for (let i = 0; i < rows.length; ++i) {
        const row = rows[i];
        const login = row.querySelector('.members-item-login').textContent;
        const privileges = row.querySelector('select').value;

        // Add to patch, if different from stored version
        if (!members_before[login] || members_before[login].privileges !== privileges) {
            patch[login] = {privileges: privileges};
        }

        // Remove from object, so what's left are the removed members
        delete members_before[login];
    }

    // Remove the members that are left
    const entries = Object.entries(members_before);
    for (let i = 0; i < entries.length; ++i) {
        patch[entries[i][0]] = null;
    }

    log("Patching users list");
    showSpinner();
    patchJSON('/api/permissions', patch)
        .then(function () {
            log("Users list patched");
        })
        .catch(function (error) {
            log("Failed to patch users list", 'error', {error});
            showAlert(`${gettext("Couldn't update permissions!")} \n \n`, 'error', {error})
        })
        .then(hideSpinner);

    members_initial = {};
}

document.getElementById('members-submit').addEventListener('click', function (e) {
    e.preventDefault();
    sendMembersPatch();
});

document.getElementById('members-current').addEventListener('submit', function (e) {
    e.preventDefault();
    sendMembersPatch();
});