# scripts/set-password.ps1
# Double-click or run: powershell -ExecutionPolicy Bypass -File scripts/set-password.ps1
#
# Shows a Windows dialog to enter a password, then hashes it and saves to auth.json.

Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null

# Capture script directory at top level (not inside click handler)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeScript = Join-Path $scriptDir "set-password.js"

$form = New-Object System.Windows.Forms.Form
$form.Text = "Set Dashboard Password"
$form.Size = New-Object System.Drawing.Size(380, 240)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.Font = New-Object System.Drawing.Font("Segoe UI", 10)

# --- Labels ---
$label = New-Object System.Windows.Forms.Label
$label.Text = "Enter a password for the ngrok dashboard:"
$label.Location = New-Object System.Drawing.Point(20, 15)
$label.Size = New-Object System.Drawing.Size(330, 22)
$form.Controls.Add($label)

$pwLabel = New-Object System.Windows.Forms.Label
$pwLabel.Text = "Password:"
$pwLabel.Location = New-Object System.Drawing.Point(20, 55)
$pwLabel.Size = New-Object System.Drawing.Size(80, 22)
$form.Controls.Add($pwLabel)

$confirmLabel = New-Object System.Windows.Forms.Label
$confirmLabel.Text = "Confirm:"
$confirmLabel.Location = New-Object System.Drawing.Point(20, 95)
$confirmLabel.Size = New-Object System.Drawing.Size(80, 22)
$form.Controls.Add($confirmLabel)

# --- Password inputs ---
$pwBox = New-Object System.Windows.Forms.TextBox
$pwBox.Location = New-Object System.Drawing.Point(110, 52)
$pwBox.Size = New-Object System.Drawing.Size(230, 22)
$pwBox.PasswordChar = '*'
$pwBox.TabIndex = 0
$form.Controls.Add($pwBox)

$confirmBox = New-Object System.Windows.Forms.TextBox
$confirmBox.Location = New-Object System.Drawing.Point(110, 92)
$confirmBox.Size = New-Object System.Drawing.Size(230, 22)
$confirmBox.PasswordChar = '*'
$confirmBox.TabIndex = 1
$form.Controls.Add($confirmBox)

# --- Error label (hidden by default) ---
$errorLabel = New-Object System.Windows.Forms.Label
$errorLabel.Text = ""
$errorLabel.ForeColor = "Red"
$errorLabel.Location = New-Object System.Drawing.Point(20, 125)
$errorLabel.Size = New-Object System.Drawing.Size(330, 22)
$errorLabel.Visible = $false
$form.Controls.Add($errorLabel)

# --- OK button ---
$okBtn = New-Object System.Windows.Forms.Button
$okBtn.Text = "Set Password"
$okBtn.Location = New-Object System.Drawing.Point(130, 155)
$okBtn.Size = New-Object System.Drawing.Size(110, 30)
$okBtn.BackColor = [System.Drawing.Color]::FromArgb(70, 106, 90)
$okBtn.ForeColor = "White"
$okBtn.FlatStyle = "Flat"
$okBtn.FlatAppearance.BorderSize = 0
$okBtn.Cursor = "Hand"
$okBtn.TabIndex = 2
$form.Controls.Add($okBtn)

# --- OK button click ---
$okBtn.Add_Click({
    $pw = $pwBox.Text
    $cf = $confirmBox.Text

    if ($pw.Length -eq 0) {
        $errorLabel.Text = "Password cannot be empty."
        $errorLabel.Visible = $true
        return
    }

    if ($pw -ne $cf) {
        $errorLabel.Text = "Passwords do not match."
        $errorLabel.Visible = $true
        return
    }

    if ($pw.Length -lt 4) {
        $errorLabel.Text = "Password must be at least 4 characters."
        $errorLabel.Visible = $true
        return
    }

    # Run the Node.js script (path captured at top of script)
    if (-not (Test-Path $nodeScript)) {
        $errorLabel.Text = "Cannot find set-password.js in scripts folder."
        $errorLabel.Visible = $true
        return
    }

    # Pass password via environment variable to avoid any shell escaping issues
    $env:DASH_SETUP_PASSWORD = $pw
    $output = ""
    $exitCode = 1
    
    try {
        $result = & node $nodeScript 2>&1
        $output = $result -join "`n"
        $exitCode = $LASTEXITCODE
    } catch {
        $output = $_.Exception.Message
    } finally {
        Remove-Item Env:\DASH_SETUP_PASSWORD -ErrorAction SilentlyContinue
    }

    if ($exitCode -eq 0) {
        [System.Windows.Forms.MessageBox]::Show(
            "Password set successfully.`n`nRestart the dashboard server to activate authentication.",
            "Success",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        )
        $form.Close()
    } else {
        $errorLabel.Text = "Error: $output"
        $errorLabel.Visible = $true
    }
})

# --- Also allow Enter key to submit ---
$form.AcceptButton = $okBtn

# --- Cancel button ---
$cancelBtn = New-Object System.Windows.Forms.Button
$cancelBtn.Text = "Cancel"
$cancelBtn.Location = New-Object System.Drawing.Point(250, 155)
$cancelBtn.Size = New-Object System.Drawing.Size(80, 30)
$cancelBtn.FlatStyle = "Flat"
$cancelBtn.Cursor = "Hand"
$cancelBtn.Add_Click({ $form.Close() })
$form.Controls.Add($cancelBtn)

# --- Show the form ---
$pwBox.Focus()
[void] $form.ShowDialog()
